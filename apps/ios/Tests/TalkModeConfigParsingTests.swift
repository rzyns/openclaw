import AVFAudio
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

    @Test func formatsSpeechStatusTextForActiveAndDegradedSpeechPaths() {
        #expect(
            TalkModeManager._test_listeningStatusText(
                captureMode: "continuous",
                speechState: "active_apple") == "Listening (Apple STT)")
        #expect(
            TalkModeManager._test_listeningStatusText(
                captureMode: "pushToTalk",
                speechState: "active_gateway") == "Listening (PTT, Gateway STT)")
        #expect(
            TalkModeManager._test_listeningStatusText(
                captureMode: "continuous",
                speechState: "gateway_fallback") == "Listening (Gateway STT fallback)")
        #expect(TalkModeManager._test_readyStatusText(speechState: "gateway_unavailable") == "Gateway STT unavailable")
        #expect(TalkModeManager._test_readyStatusText(speechState: "gateway_error") == "Gateway STT error")
    }

    @Test func buffersGatewayUtteranceAudioAsWavClip() throws {
        let backend = TalkSpeechBackendFactory.make(for: TalkSpeechBackendConfiguration(
            kind: .gateway,
            configuredProviderID: "gateway",
            language: "en",
            model: "gpt-4o-transcribe"))
        guard let gatewayBackend = backend as? GatewayTalkSpeechBackend else {
            Issue.record("Expected GatewayTalkSpeechBackend instance")
            return
        }

        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)
        guard let format else {
            Issue.record("Expected mono float32 audio format")
            return
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4) else {
            Issue.record("Expected PCM buffer")
            return
        }

        buffer.frameLength = 4
        let samples = buffer.floatChannelData![0]
        samples[0] = 0.0
        samples[1] = 0.25
        samples[2] = -0.25
        samples[3] = 0.5

        gatewayBackend.appendAudioBuffer(buffer)
        #expect(gatewayBackend.hasBufferedUtteranceAudio)

        let clip = gatewayBackend.takeBufferedUtteranceAudio()
        #expect(clip?.mimeType == "audio/wav")
        #expect(clip?.fileExtension == "wav")
        #expect(clip?.data.count == 52)
        #expect(clip?.data.prefix(4) == Data("RIFF".utf8))
        #expect(gatewayBackend.takeBufferedUtteranceAudio() == nil)
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
