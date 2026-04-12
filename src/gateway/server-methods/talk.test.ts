import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { talkHandlers } from "./talk.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshot: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  synthesizeSpeech: vi.fn(),
  buildMediaUnderstandingRegistry: vi.fn(),
  getMediaUnderstandingProvider: vi.fn(),
  normalizeMediaProviderId: vi.fn((providerId: string | undefined) =>
    providerId?.trim().toLowerCase() ?? ""
  ),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
}));

vi.mock("../../tts/tts.js", () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
}));

function createTalkConfig(apiKey: unknown): OpenClawConfig {
  return {
    talk: {
      provider: "acme",
      providers: {
        acme: {
          apiKey,
          voiceId: "stub-default-voice",
        },
      },
    },
  } as OpenClawConfig;
}

function createTalkSttConfig(
  providerConfig: Record<string, unknown>,
  providerId = "deepgram",
): OpenClawConfig {
  return {
    talk: {
      sttProvider: providerId,
      sttProviders: {
        [providerId]: providerConfig,
      },
    },
  } as OpenClawConfig;
}

async function invokeTalkTranscribe(params: unknown) {
  const respond = vi.fn();
  await talkHandlers["talk.transcribe"]({
    req: { type: "req", id: "1", method: "talk.transcribe" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: respond as never,
    context: {} as never,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0];
}

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
  });

  it("uses the active runtime config snapshot instead of the raw config snapshot", async () => {
    const runtimeConfig = createTalkConfig("env-acme-key");
    const diskConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: diskConfig,
    });
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Speech",
      resolveTalkConfig: ({
        talkProviderConfig,
      }: {
        talkProviderConfig: Record<string, unknown>;
      }) => talkProviderConfig,
    });
    mocks.synthesizeSpeech.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig; text: string; disableFallback: boolean }) => {
        expect(cfg.messages?.tts?.provider).toBe("acme");
        expect(cfg.messages?.tts?.providers?.acme?.apiKey).toBe("env-acme-key");
        return {
          success: true,
          provider: "acme",
          audioBuffer: Buffer.from([1, 2, 3]),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        };
      },
    );

    const respond = vi.fn();
    await talkHandlers["talk.speak"]({
      req: { type: "req", id: "1", method: "talk.speak" },
      params: { text: "Hello from talk mode." },
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from talk mode.",
        disableFallback: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "acme",
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        outputFormat: "mp3",
        mimeType: "audio/mpeg",
        fileExtension: ".mp3",
      }),
      undefined,
    );
  });
});

describe("talk.transcribe handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
  });

  it("rejects invalid params", async () => {
    const [ok, result, error] = await invokeTalkTranscribe({ audioBase64: "" });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid talk.transcribe params"),
    });
  });

  it("rejects missing Talk STT config", async () => {
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: {
        reason: "talk_stt_unconfigured",
        retryable: false,
      },
    });
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key" }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "deepgram" });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: {
        reason: "talk_stt_provider_unsupported",
        retryable: false,
      },
    });
  });

  it("rejects non-string or missing resolved API keys", async () => {
    mocks.loadConfig.mockReturnValue(
      createTalkSttConfig({
        apiKey: {
          source: "env",
          provider: "default",
          id: "DEEPGRAM_API_KEY",
        },
      }),
    );

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: {
        reason: "talk_stt_auth_unavailable",
        retryable: false,
      },
    });
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("returns transcript, provider, and model on success", async () => {
    const runtimeConfig = createTalkSttConfig({
      apiKey: "test-key",
      model: "nova-3",
      language: "pl",
      baseUrl: "https://stt.example/v1",
      headers: {
        "X-Test": "1",
      },
      request: {
        headers: {
          "X-Request": "cfg",
        },
      },
      query: {
        punctuate: true,
      },
    });
    const registry = new Map();
    const transcribeAudio = vi.fn().mockResolvedValue({
      text: "  cześć  ",
      model: "returned-model",
    });

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(registry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "deepgram",
      transcribeAudio,
    });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio-bytes").toString("base64"),
      mimeType: "audio/wav",
      fileExtension: "wav",
      language: "en",
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(result).toEqual({
      text: "cześć",
      provider: "deepgram",
      model: "returned-model",
    });
    expect(mocks.buildMediaUnderstandingRegistry).toHaveBeenCalledWith(undefined, runtimeConfig);
    expect(mocks.getMediaUnderstandingProvider).toHaveBeenCalledWith("deepgram", registry);
    expect(transcribeAudio).toHaveBeenCalledWith({
      buffer: Buffer.from("audio-bytes"),
      fileName: "utterance.wav",
      mime: "audio/wav",
      apiKey: "test-key",
      model: "nova-3",
      language: "en",
      baseUrl: "https://stt.example/v1",
      headers: {
        "X-Test": "1",
      },
      request: {
        headers: {
          "X-Request": "cfg",
        },
      },
      query: {
        punctuate: true,
      },
      timeoutMs: 30_000,
    });
  });

  it("rejects malformed base64 audio payloads", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key" }));

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: "%%%not-base64%%%",
      mimeType: "audio/wav",
      fileExtension: "wav",
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        reason: "invalid_audio_payload",
        retryable: false,
      },
    });
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("rejects invalid talk.transcribe file extensions", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key" }));

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
      fileExtension: "../../wav",
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        reason: "invalid_audio_payload",
        retryable: false,
      },
    });
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("uses configured language hints when the request omits one", async () => {
    mocks.loadConfig.mockReturnValue(
      createTalkSttConfig({
        apiKey: "test-key",
        model: "nova-3",
        language: "pl",
      }),
    );
    const transcribeAudio = vi.fn().mockResolvedValue({
      text: "dzień dobry",
      detectedLanguage: "pl",
    });
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "deepgram",
      transcribeAudio,
    });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(result).toEqual({
      text: "dzień dobry",
      provider: "deepgram",
      model: "nova-3",
      detectedLanguage: "pl",
    });
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "pl",
      }),
    );
  });

  it("returns empty_transcript when the provider responds with whitespace", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key" }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "deepgram",
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "   ",
      }),
    });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      details: {
        reason: "empty_transcript",
        retryable: false,
      },
    });
  });

  it("surfaces transcription failures as retryable", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key" }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "deepgram",
      transcribeAudio: vi.fn().mockRejectedValue(new Error("provider timeout")),
    });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("provider timeout"),
      details: {
        reason: "transcription_failed",
        retryable: true,
      },
    });
  });

  it("includes detectedLanguage when the provider returns it", async () => {
    mocks.loadConfig.mockReturnValue(createTalkSttConfig({ apiKey: "test-key", model: "nova-3" }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "deepgram",
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "hello",
        model: "nova-3",
        detectedLanguage: "en",
      }),
    });

    const [ok, result, error] = await invokeTalkTranscribe({
      audioBase64: Buffer.from("audio").toString("base64"),
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(result).toEqual({
      text: "hello",
      provider: "deepgram",
      model: "nova-3",
      detectedLanguage: "en",
    });
  });
});
