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
    }
}
