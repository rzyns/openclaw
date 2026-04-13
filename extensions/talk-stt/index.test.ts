import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import plugin from "./index.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveConfiguredSecretInputString: vi.fn(),
  buildMediaUnderstandingRegistry: vi.fn(),
  getMediaUnderstandingProvider: vi.fn(),
  normalizeMediaProviderId: vi.fn(
    (providerId: string | undefined) => providerId?.trim().toLowerCase() ?? "",
  ),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<object>("openclaw/plugin-sdk/config-runtime");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
    resolveConfiguredSecretInputString: mocks.resolveConfiguredSecretInputString,
  };
});

vi.mock("../../src/media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
}));

function createRuntimeConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "talk-stt": {
          enabled: true,
          config: {
            provider: "openai",
            providers: {
              openai: {
                apiKey,
                model: "gpt-4o-transcribe",
                language: "pl",
                baseUrl: "https://stt.example/v1",
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setup(config: OpenClawConfig = createRuntimeConfig("sk-test")) {
  const methods = new Map<string, unknown>();
  const api = createTestPluginApi({
    id: "talk-stt",
    name: "Talk STT",
    description: "test",
    version: "0",
    source: "test",
    config,
    runtime: {} as never,
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
  });
  void plugin.register(api);
  return { methods };
}

describe("talk-stt plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
    mocks.resolveConfiguredSecretInputString.mockResolvedValue({ value: undefined });
  });

  it("registers talkstt gateway methods", () => {
    const { methods } = setup();
    expect([...methods.keys()].toSorted()).toEqual(["talkstt.config", "talkstt.transcribe"]);
  });

  it("returns plugin-owned talkstt config payload", async () => {
    const config = createRuntimeConfig("${OPENAI_API_KEY}");
    mocks.loadConfig.mockReturnValue(config);
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { config },
      writeOptions: {},
    });

    const { methods } = setup(config);
    const handler = methods.get("talkstt.config") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
          client: unknown;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { includeSecrets: true },
      respond,
      client: { connect: { scopes: ["operator.admin"] } },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        config: {
          talkstt: {
            sttProvider: "openai",
            sttProviders: {
              openai: {
                apiKey: "${OPENAI_API_KEY}",
                model: "gpt-4o-transcribe",
                language: "pl",
                baseUrl: "https://stt.example/v1",
              },
            },
            resolvedStt: {
              provider: "openai",
              config: {
                apiKey: "${OPENAI_API_KEY}",
                model: "gpt-4o-transcribe",
                language: "pl",
                baseUrl: "https://stt.example/v1",
              },
            },
          },
        },
      },
      undefined,
    );
  });

  it("transcribes audio using plugin-owned config", async () => {
    const runtimeConfig = createRuntimeConfig("sk-test");
    const registry = new Map();
    const transcribeAudio = vi.fn().mockResolvedValue({
      text: "  cześć  ",
      model: "returned-model",
      detectedLanguage: "pl",
    });

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(registry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "openai",
      transcribeAudio,
    });

    const { methods } = setup(runtimeConfig);
    const handler = methods.get("talkstt.transcribe") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: {
        audioBase64: Buffer.from("audio-bytes").toString("base64"),
        mimeType: "audio/wav",
        fileExtension: "wav",
        language: "en",
      },
      respond,
    });

    expect(transcribeAudio).toHaveBeenCalledWith({
      buffer: Buffer.from("audio-bytes"),
      fileName: "utterance.wav",
      mime: "audio/wav",
      apiKey: "sk-test",
      model: "gpt-4o-transcribe",
      language: "en",
      baseUrl: "https://stt.example/v1",
      timeoutMs: 30_000,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        text: "cześć",
        provider: "openai",
        model: "returned-model",
        detectedLanguage: "pl",
      },
      undefined,
    );
  });
});
