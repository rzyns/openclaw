import Foundation
import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeManagerTests {
    @Test func detectsPCMFormatRejectionFromElevenLabsError() {
        let error = NSError(
            domain: "ElevenLabsTTS",
            code: 403,
            userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: 403 subscription_required output_format=pcm_44100",
            ])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error))
    }

    @Test func ignoresGenericPlaybackFailuresForPCMFormatRejection() {
        let error = NSError(
            domain: "StreamingAudio",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "queue enqueue failed"])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error) == false)
    }

    @Test func buildsExpectedSpeechBackendTypesFromConfiguration() {
        #expect(
            TalkModeManager._test_speechBackendTypeName(for: .appleDefault) == "AppleTalkSpeechBackend")
        #expect(
            TalkModeManager._test_speechBackendTypeName(
                for: TalkSpeechBackendConfiguration(
                    kind: .gateway,
                    configuredProviderID: "gateway",
                    language: "pl",
                    model: "gpt-4o-transcribe")) == "GatewayTalkSpeechBackend")
    }
}

@Suite struct TalkModeGatewayConfigParserTests {
    @Test func parsesResolvedSttConfigSeparatelyFromTtsConfig() {
        let config: [String: Any] = [
            "talk": [
                "provider": "elevenlabs",
                "providers": [
                    "elevenlabs": [
                        "voiceId": "voice-normalized",
                        "modelId": "eleven_flash_v2_5",
                    ],
                ],
                "resolved": [
                    "provider": "elevenlabs",
                    "config": [
                        "voiceId": "voice-resolved",
                        "modelId": "eleven_flash_v2_5",
                    ],
                ],
                "sttProvider": "openai",
                "sttProviders": [
                    "openai": [
                        "language": "pl",
                        "model": "gpt-4o-transcribe",
                    ],
                ],
                "resolvedStt": [
                    "provider": "openai",
                    "config": [
                        "language": "pl",
                        "model": "gpt-4o-transcribe",
                    ],
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultSttProvider: "openai",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeProvider == "elevenlabs")
        #expect(parsed.defaultVoiceId == "voice-resolved")
        #expect(parsed.activeSttProvider == "openai")
        #expect(parsed.sttLanguage == "pl")
        #expect(parsed.sttModel == "gpt-4o-transcribe")
        #expect(parsed.sttBackend.kind == .apple)
        #expect(parsed.sttBackend.configuredProviderID == "openai")
    }

    @Test func keepsAppleSpeechBackendForNonGatewaySttProviders() {
        let config: [String: Any] = [
            "talk": [
                "sttProvider": "openai",
                "sttProviders": [
                    "openai": [
                        "language": "en",
                        "model": "whisper-1",
                    ],
                ],
                "resolvedStt": [
                    "provider": "openai",
                    "config": [
                        "language": "en",
                        "model": "whisper-1",
                    ],
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultSttProvider: "openai",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeSttProvider == "openai")
        #expect(parsed.sttBackend.kind == .apple)
        #expect(parsed.sttBackend.configuredProviderID == "openai")
        #expect(parsed.sttBackend.language == "en")
        #expect(parsed.sttBackend.model == "whisper-1")
    }

    @Test func selectsGatewaySpeechBackendWhenGatewayProviderConfigured() {
        let config: [String: Any] = [
            "talk": [
                "sttProvider": "gateway",
                "sttProviders": [
                    "gateway": [
                        "language": "pl",
                        "model": "gpt-4o-transcribe",
                    ],
                ],
                "resolvedStt": [
                    "provider": "gateway",
                    "config": [
                        "language": "pl",
                        "model": "gpt-4o-transcribe",
                    ],
                ],
            ],
        ]

        let parsed = TalkModeGatewayConfigParser.parse(
            config: config,
            defaultProvider: "elevenlabs",
            defaultSttProvider: "openai",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeSttProvider == "gateway")
        #expect(parsed.sttBackend.kind == .gateway)
        #expect(parsed.sttBackend.configuredProviderID == "gateway")
        #expect(parsed.sttBackend.language == "pl")
        #expect(parsed.sttBackend.model == "gpt-4o-transcribe")
    }

    @Test func defaultsToAppleSpeechBackendWhenSttConfigIsAbsent() {
        let parsed = TalkModeGatewayConfigParser.parse(
            config: [:],
            defaultProvider: "elevenlabs",
            defaultSttProvider: "openai",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.activeSttProvider == "openai")
        #expect(parsed.sttBackend.kind == .apple)
        #expect(parsed.sttBackend.configuredProviderID == nil)
        #expect(parsed.sttBackend.language == nil)
        #expect(parsed.sttBackend.model == nil)
    }
}
