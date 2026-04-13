import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildTalkConfigResponse,
  normalizeTalkSection,
  resolveActiveSttProviderConfig,
  resolveActiveTalkProviderConfig,
} from "../../config/talk.js";
import type { TalkConfigResponse, TalkProviderConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../config/types.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "../../media-understanding/provider-registry.js";
import type {
  MediaUnderstandingProvider,
  MediaUnderstandingProviderRequestTransportOverrides,
} from "../../media-understanding/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "../../tts/provider-registry.js";
import { synthesizeSpeech, type TtsDirectiveOverrides } from "../../tts/tts.js";
import { ADMIN_SCOPE, TALK_SECRETS_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TalkSpeakParams,
  type TalkTranscribeParams,
  validateTalkConfigParams,
  validateTalkModeParams,
  validateTalkSpeakParams,
  validateTalkTranscribeParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import { asRecord } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "method_unavailable"
  | "synthesis_failed"
  | "invalid_audio_result";

type TalkSpeakErrorDetails = {
  reason: TalkSpeakReason;
  fallbackEligible: boolean;
};

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

type ProviderQuery = Record<string, string | number | boolean>;

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

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue === "string") {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function asProviderQueryRecord(value: unknown): ProviderQuery | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const next: ProviderQuery = {};
  for (const [key, entryValue] of Object.entries(record)) {
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
  const record = asRecord(value);
  return record ? (record as MediaUnderstandingProviderRequestTransportOverrides) : undefined;
}

function normalizeAliasKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = asStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeAliasKey(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeAliasKey(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const baseTts = config.messages?.tts ?? {};
  const providerConfig = resolved.config;
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      messages: {
        ...config.messages,
        tts: talkTts,
      },
    },
  };
}

function resolveTalkTranscribeSetup(
  config: OpenClawConfig,
): TalkTranscribeSetup | { error: string; reason: TalkTranscribeReason } {
  const resolvedStt = resolveActiveSttProviderConfig(config.talk);
  const providerId = normalizeMediaProviderId(resolvedStt?.provider ?? "");
  if (!resolvedStt || !providerId) {
    return {
      error: "talk.transcribe unavailable: Talk STT provider not configured",
      reason: "talk_stt_unconfigured",
    };
  }

  const apiKey = normalizeOptionalString(
    typeof resolvedStt.config.apiKey === "string" ? resolvedStt.config.apiKey : undefined,
  );
  if (!apiKey) {
    return {
      error: `talk.transcribe unavailable: Talk STT provider "${providerId}" is missing a resolved apiKey string`,
      reason: "talk_stt_auth_unavailable",
    };
  }

  const registry = buildMediaUnderstandingRegistry(undefined, config);
  const mediaProvider = getMediaUnderstandingProvider(providerId, registry);
  if (!mediaProvider?.transcribeAudio) {
    return {
      error: `talk.transcribe unavailable: media provider "${providerId}" does not support audio transcription`,
      reason: "talk_stt_provider_unsupported",
    };
  }

  const rawProviderConfig = asRecord(resolvedStt.config) ?? {};
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
    model: normalizeOptionalString(resolvedStt.config.model),
    language: normalizeOptionalString(resolvedStt.config.language),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(request ? { request } : {}),
    ...(query ? { query } : {}),
  };
}

function isFallbackEligibleTalkReason(reason: TalkSpeakReason): boolean {
  return (
    reason === "talk_unconfigured" ||
    reason === "talk_provider_unsupported" ||
    reason === "method_unavailable"
  );
}

function talkSpeakError(reason: TalkSpeakReason, message: string) {
  const details: TalkSpeakErrorDetails = {
    reason,
    fallbackEligible: isFallbackEligibleTalkReason(reason),
  };
  return errorShape(ErrorCodes.UNAVAILABLE, message, { details });
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

function resolveTalkSpeed(params: TalkSpeakParams): number | undefined {
  if (typeof params.speed === "number") {
    return params.speed;
  }
  if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) {
    return undefined;
  }
  const resolved = params.rateWpm / 175;
  if (resolved <= 0.5 || resolved >= 2.0) {
    return undefined;
  }
  return resolved;
}

function buildTalkSpeakOverrides(
  provider: string,
  providerConfig: TalkProviderConfig,
  config: OpenClawConfig,
  params: TalkSpeakParams,
): TtsDirectiveOverrides {
  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider?.resolveTalkOverrides) {
    return { provider };
  }
  const resolvedSpeed = resolveTalkSpeed(params);
  const resolvedVoiceId = resolveTalkVoiceId(
    providerConfig,
    normalizeOptionalString(params.voiceId),
  );
  const providerOverrides = speechProvider.resolveTalkOverrides({
    talkProviderConfig: providerConfig,
    params: {
      ...params,
      ...(resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId }),
      ...(resolvedSpeed == null ? {} : { speed: resolvedSpeed }),
    },
  });
  if (!providerOverrides || Object.keys(providerOverrides).length === 0) {
    return { provider };
  }
  return {
    provider,
    providerOverrides: {
      [provider]: providerOverrides,
    },
  };
}

function inferMimeType(
  outputFormat: string | undefined,
  fileExtension: string | undefined,
): string | undefined {
  const normalizedOutput = normalizeOptionalLowercaseString(outputFormat);
  const normalizedExtension = normalizeOptionalLowercaseString(fileExtension);
  if (
    normalizedOutput === "mp3" ||
    normalizedOutput?.startsWith("mp3_") ||
    normalizedOutput?.endsWith("-mp3") ||
    normalizedExtension === ".mp3"
  ) {
    return "audio/mpeg";
  }
  if (
    normalizedOutput === "opus" ||
    normalizedOutput?.startsWith("opus_") ||
    normalizedExtension === ".opus" ||
    normalizedExtension === ".ogg"
  ) {
    return "audio/ogg";
  }
  if (normalizedOutput?.endsWith("-wav") || normalizedExtension === ".wav") {
    return "audio/wav";
  }
  if (normalizedOutput?.endsWith("-webm") || normalizedExtension === ".webm") {
    return "audio/webm";
  }
  return undefined;
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

function resolveTalkResponseFromConfig(params: {
  includeSecrets: boolean;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}): TalkConfigResponse | undefined {
  const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
  if (!normalizedTalk) {
    return undefined;
  }

  const payload = buildTalkConfigResponse(normalizedTalk);
  if (!payload) {
    return undefined;
  }

  if (params.includeSecrets) {
    return payload;
  }

  const sourceResolved = resolveActiveTalkProviderConfig(normalizedTalk);
  const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
  const activeProviderId = sourceResolved?.provider ?? runtimeResolved?.provider;
  const provider = canonicalizeSpeechProviderId(activeProviderId, params.runtimeConfig);
  if (!provider) {
    return payload;
  }

  const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
  const sourceBaseTts = asRecord(params.sourceConfig.messages?.tts) ?? {};
  const runtimeBaseTts = asRecord(params.runtimeConfig.messages?.tts) ?? {};
  const talkProviderConfig = sourceResolved?.config ?? runtimeResolved?.config ?? {};
  const resolvedConfig =
    speechProvider?.resolveTalkConfig?.({
      cfg: params.runtimeConfig,
      baseTtsConfig: Object.keys(sourceBaseTts).length > 0 ? sourceBaseTts : runtimeBaseTts,
      talkProviderConfig,
      timeoutMs:
        typeof sourceBaseTts.timeoutMs === "number"
          ? sourceBaseTts.timeoutMs
          : typeof runtimeBaseTts.timeoutMs === "number"
            ? runtimeBaseTts.timeoutMs
            : 30_000,
    }) ?? talkProviderConfig;

  return {
    ...payload,
    provider,
    resolved: {
      provider,
      config: resolvedConfig,
    },
  };
}

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
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

    const snapshot = await readConfigFileSnapshot();
    const runtimeConfig = loadConfig();
    const configPayload: Record<string, unknown> = {};

    const talk = resolveTalkResponseFromConfig({
      includeSecrets,
      sourceConfig: snapshot.config,
      runtimeConfig,
    });
    if (talk) {
      configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.speak": async ({ params, respond }) => {
    if (!validateTalkSpeakParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: ${formatValidationErrors(validateTalkSpeakParams.errors)}`,
        ),
      );
      return;
    }

    const typedParams = params;
    const text = normalizeOptionalString(typedParams.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    if (
      typedParams.speed == null &&
      typedParams.rateWpm != null &&
      resolveTalkSpeed(typedParams) == null
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid talk.speak params: rateWpm must resolve to speed between 0.5 and 2.0",
        ),
      );
      return;
    }

    try {
      const runtimeConfig = loadConfig();
      const setup = buildTalkTtsConfig(runtimeConfig);
      if ("error" in setup) {
        respond(false, undefined, talkSpeakError(setup.reason, setup.error));
        return;
      }

      const overrides = buildTalkSpeakOverrides(
        setup.provider,
        setup.providerConfig,
        runtimeConfig,
        typedParams,
      );
      const result = await synthesizeSpeech({
        text,
        cfg: setup.cfg,
        overrides,
        disableFallback: true,
      });
      if (!result.success || !result.audioBuffer) {
        respond(
          false,
          undefined,
          talkSpeakError("synthesis_failed", result.error ?? "talk synthesis failed"),
        );
        return;
      }
      if ((result.provider ?? setup.provider).trim().length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty provider"),
        );
        return;
      }
      if (result.audioBuffer.length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty audio"),
        );
        return;
      }

      respond(
        true,
        {
          audioBase64: result.audioBuffer.toString("base64"),
          provider: result.provider ?? setup.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
          mimeType: inferMimeType(result.outputFormat, result.fileExtension),
          fileExtension: result.fileExtension,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, talkSpeakError("synthesis_failed", formatForLog(err)));
    }
  },
  "talk.transcribe": async ({ params, respond }) => {
    if (!validateTalkTranscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcribe params: ${formatValidationErrors(validateTalkTranscribeParams.errors)}`,
        ),
      );
      return;
    }

    const typedParams = params as TalkTranscribeParams;
    const audioBuffer = decodeTalkAudioBase64(typedParams.audioBase64);
    if (!audioBuffer) {
      respond(
        false,
        undefined,
        talkTranscribeError(
          "invalid_audio_payload",
          "talk.transcribe requires a valid non-empty base64 audio payload",
        ),
      );
      return;
    }

    const normalizedExtension = normalizeTalkAudioExtension(typedParams.fileExtension);
    if (typedParams.fileExtension != null && normalizedExtension == null) {
      respond(
        false,
        undefined,
        talkTranscribeError(
          "invalid_audio_payload",
          "talk.transcribe fileExtension must be a simple audio container extension",
        ),
      );
      return;
    }

    const mimeType = normalizeOptionalString(typedParams.mimeType);
    const requestedLanguage = normalizeOptionalString(typedParams.language);

    try {
      const runtimeConfig = loadConfig();
      const setup = resolveTalkTranscribeSetup(runtimeConfig);
      if ("error" in setup) {
        respond(false, undefined, talkTranscribeError(setup.reason, setup.error));
        return;
      }

      const language = requestedLanguage ?? setup.language;
      const result = await setup.transcribeAudio({
        buffer: audioBuffer,
        fileName: resolveTalkTranscribeFileName(normalizedExtension ?? undefined),
        ...(mimeType ? { mime: mimeType } : {}),
        apiKey: setup.apiKey,
        ...(setup.model ? { model: setup.model } : {}),
        ...(language ? { language } : {}),
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
          talkTranscribeError("empty_transcript", "talk.transcribe returned an empty transcript"),
        );
        return;
      }

      const model = normalizeOptionalString(result.model) ?? setup.model;
      const detectedLanguage = normalizeOptionalString(result.detectedLanguage);

      respond(
        true,
        {
          text,
          provider: setup.providerId,
          ...(model ? { model } : {}),
          ...(detectedLanguage ? { detectedLanguage } : {}),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        talkTranscribeError("transcription_failed", formatForLog(err)),
      );
    }
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
