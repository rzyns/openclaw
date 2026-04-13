import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  resolveConfiguredSecretInputString,
} from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { redactConfigObject } from "../../src/config/redact-snapshot.js";
import { buildTalkConfigResponse, resolveActiveSttProviderConfig } from "../../src/config/talk.js";
import { ADMIN_SCOPE, TALK_SECRETS_SCOPE } from "../../src/gateway/operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkConfigParams,
  validateTalkTranscribeParams,
} from "../../src/gateway/protocol/index.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "../../src/media-understanding/provider-registry.js";
import type {
  MediaUnderstandingProvider,
  MediaUnderstandingProviderRequestTransportOverrides,
} from "../../src/media-understanding/types.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../src/shared/string-coerce.js";

type ProviderQuery = Record<string, string | number | boolean>;

type TalkTranscribeReason =
  | "talk_stt_unconfigured"
  | "talk_stt_provider_unsupported"
  | "talk_stt_auth_unavailable"
  | "invalid_audio_payload"
  | "transcription_failed"
  | "empty_transcript";

type TalkTranscribeErrorDetails = {
  reason: TalkTranscribeReason;
  retryable: boolean;
};

type TalkTranscribeSetup = {
  providerId: string;
  transcribeAudio: NonNullable<MediaUnderstandingProvider["transcribeAudio"]>;
  apiKey: string;
  model?: string;
  language?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: MediaUnderstandingProviderRequestTransportOverrides;
  query?: ProviderQuery;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function asProviderQueryRecord(value: unknown): ProviderQuery | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const next: ProviderQuery = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean"
    ) {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function asProviderRequestTransportOverrides(
  value: unknown,
): MediaUnderstandingProviderRequestTransportOverrides | undefined {
  return isRecord(value)
    ? (value as MediaUnderstandingProviderRequestTransportOverrides)
    : undefined;
}

function resolveTalkSttSection(config: OpenClawConfig): Record<string, unknown> | undefined {
  const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : undefined;
  const pluginEntry = entries && isRecord(entries["talk-stt"]) ? entries["talk-stt"] : undefined;
  const pluginConfig = pluginEntry && isRecord(pluginEntry.config) ? pluginEntry.config : undefined;
  if (!pluginConfig) {
    return undefined;
  }

  const provider = normalizeOptionalString(pluginConfig.provider);
  const providers = isRecord(pluginConfig.providers) ? pluginConfig.providers : undefined;
  if (!provider && !providers) {
    return undefined;
  }

  return {
    ...(provider ? { sttProvider: provider } : {}),
    ...(providers ? { sttProviders: providers } : {}),
  };
}

function isRetryableTalkTranscribeReason(reason: TalkTranscribeReason): boolean {
  return reason === "transcription_failed";
}

function talkTranscribeError(reason: TalkTranscribeReason, message: string) {
  const details: TalkTranscribeErrorDetails = {
    reason,
    retryable: isRetryableTalkTranscribeReason(reason),
  };
  return errorShape(
    reason === "invalid_audio_payload" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    message,
    { details },
  );
}

function normalizeTalkAudioExtension(value: string | undefined): string | undefined | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-z0-9]+$/.test(normalized) && !/^\.[a-z0-9]+$/.test(normalized)) {
    return null;
  }
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function decodeTalkAudioBase64(value: string): Buffer | null {
  const normalized = value.replace(/\s+/gu, "").trim();
  if (!normalized || normalized.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    return null;
  }
  try {
    const buffer = Buffer.from(normalized, "base64");
    if (buffer.length === 0) {
      return null;
    }
    const roundTrip = buffer.toString("base64").replace(/=+$/u, "");
    if (roundTrip !== normalized.replace(/=+$/u, "")) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

function resolveTalkTranscribeFileName(fileExtension: string | undefined): string {
  return `utterance${fileExtension ?? ".wav"}`;
}

async function resolveTalkTranscribeSetup(
  config: OpenClawConfig,
): Promise<TalkTranscribeSetup | { error: string; reason: TalkTranscribeReason }> {
  const talkStt = resolveTalkSttSection(config);
  const resolvedStt = resolveActiveSttProviderConfig(talkStt);
  const providerId = normalizeMediaProviderId(resolvedStt?.provider ?? "");
  if (!resolvedStt || !providerId) {
    return {
      error: "talkstt.transcribe unavailable: Talk STT provider not configured",
      reason: "talk_stt_unconfigured",
    };
  }

  const rawProviderConfig = isRecord(resolvedStt.config) ? resolvedStt.config : {};
  let apiKey = normalizeOptionalString(
    typeof rawProviderConfig.apiKey === "string" ? rawProviderConfig.apiKey : undefined,
  );
  if (!apiKey && rawProviderConfig.apiKey !== undefined) {
    const resolved = await resolveConfiguredSecretInputString({
      config,
      env: process.env,
      value: rawProviderConfig.apiKey,
      path: `plugins.entries.talk-stt.config.providers.${providerId}.apiKey`,
    });
    apiKey = resolved.value;
  }
  if (!apiKey) {
    return {
      error: `talkstt.transcribe unavailable: Talk STT provider "${providerId}" is missing a resolved apiKey string`,
      reason: "talk_stt_auth_unavailable",
    };
  }

  const registry = buildMediaUnderstandingRegistry(undefined, config);
  const mediaProvider = getMediaUnderstandingProvider(providerId, registry);
  if (!mediaProvider?.transcribeAudio) {
    return {
      error: `talkstt.transcribe unavailable: media provider "${providerId}" does not support audio transcription`,
      reason: "talk_stt_provider_unsupported",
    };
  }

  const baseUrl = normalizeOptionalString(
    typeof rawProviderConfig.baseUrl === "string" ? rawProviderConfig.baseUrl : undefined,
  );
  const headers = asStringRecord(rawProviderConfig.headers);
  const request = asProviderRequestTransportOverrides(rawProviderConfig.request);
  const query = asProviderQueryRecord(rawProviderConfig.query);

  return {
    providerId,
    transcribeAudio: mediaProvider.transcribeAudio,
    apiKey,
    model: normalizeOptionalString(rawProviderConfig.model),
    language: normalizeOptionalString(rawProviderConfig.language),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(request ? { request } : {}),
    ...(query ? { query } : {}),
  };
}

export default definePluginEntry({
  id: "talk-stt",
  name: "Talk STT",
  description: "Talk STT compatibility shim for plugin-owned gateway transcription config",
  register(api: OpenClawPluginApi) {
    api.registerGatewayMethod(
      "talkstt.config",
      async ({ params, respond, client }) => {
        if (!validateTalkConfigParams(params)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid talkstt.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
            ),
          );
          return;
        }

        const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
        if (includeSecrets && !canReadTalkSecrets(client)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
          );
          return;
        }

        const { snapshot } = await readConfigFileSnapshotForWrite();
        const runtimeConfig = loadConfig();
        const sourcePayload = buildTalkConfigResponse(resolveTalkSttSection(snapshot.config));
        const runtimePayload = buildTalkConfigResponse(resolveTalkSttSection(runtimeConfig));
        const payload = includeSecrets
          ? (sourcePayload ?? runtimePayload)
          : (runtimePayload ?? sourcePayload);

        respond(
          true,
          {
            config: payload
              ? {
                  talkstt: includeSecrets ? payload : redactConfigObject(payload),
                }
              : {},
          },
          undefined,
        );
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "talkstt.transcribe",
      async ({ params, respond }) => {
        if (!validateTalkTranscribeParams(params)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid talkstt.transcribe params: ${formatValidationErrors(validateTalkTranscribeParams.errors)}`,
            ),
          );
          return;
        }

        const runtimeConfig = loadConfig();
        const setup = await resolveTalkTranscribeSetup(runtimeConfig);
        if ("error" in setup) {
          respond(false, undefined, talkTranscribeError(setup.reason, setup.error));
          return;
        }

        const audioBase64 = normalizeOptionalString(params.audioBase64);
        const audioBuffer = audioBase64 ? decodeTalkAudioBase64(audioBase64) : null;
        if (!audioBuffer) {
          respond(
            false,
            undefined,
            talkTranscribeError(
              "invalid_audio_payload",
              "talkstt.transcribe requires a valid non-empty base64 audio payload",
            ),
          );
          return;
        }

        const fileExtension = normalizeTalkAudioExtension(
          normalizeOptionalString(params.fileExtension),
        );
        if (fileExtension === null) {
          respond(
            false,
            undefined,
            talkTranscribeError(
              "invalid_audio_payload",
              "talkstt.transcribe fileExtension must be a simple audio container extension",
            ),
          );
          return;
        }

        const requestedLanguage = normalizeOptionalString(params.language) ?? setup.language;

        try {
          const result = await setup.transcribeAudio({
            buffer: audioBuffer,
            fileName: resolveTalkTranscribeFileName(fileExtension),
            mime: normalizeOptionalString(params.mimeType),
            apiKey: setup.apiKey,
            model: setup.model,
            language: requestedLanguage,
            ...(setup.baseUrl ? { baseUrl: setup.baseUrl } : {}),
            ...(setup.headers ? { headers: setup.headers } : {}),
            ...(setup.request ? { request: setup.request } : {}),
            ...(setup.query ? { query: setup.query } : {}),
            timeoutMs: 30_000,
          });
          const text = normalizeOptionalString(result.text);
          if (!text) {
            respond(
              false,
              undefined,
              talkTranscribeError(
                "empty_transcript",
                "talkstt.transcribe returned an empty transcript",
              ),
            );
            return;
          }

          respond(
            true,
            {
              text,
              provider: setup.providerId,
              model: normalizeOptionalString(result.model) ?? setup.model,
              ...(normalizeOptionalString(result.detectedLanguage)
                ? { detectedLanguage: normalizeOptionalString(result.detectedLanguage) }
                : {}),
            },
            undefined,
          );
        } catch (error) {
          respond(
            false,
            undefined,
            talkTranscribeError(
              "transcription_failed",
              `talkstt.transcribe failed: ${formatErrorMessage(error)}`,
            ),
          );
        }
      },
      { scope: "operator.write" },
    );
  },
});
