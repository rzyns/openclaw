import AVFAudio
import Foundation
import Speech

enum TalkSpeechBackendKind: String, Equatable, Sendable {
    case apple
    case gateway
}

struct TalkSpeechBackendConfiguration: Equatable, Sendable {
    let kind: TalkSpeechBackendKind
    let configuredProviderID: String?
    let language: String?
    let model: String?

    static let appleDefault = Self(kind: .apple, configuredProviderID: nil, language: nil, model: nil)
}

struct TalkSpeechBackendResult: Sendable {
    let transcript: String
    let isFinal: Bool
}

enum TalkSpeechBackendEvent: Sendable {
    case transcript(TalkSpeechBackendResult)
    case failure(message: String, isCancellation: Bool)
}

protocol TalkSpeechBackend: AnyObject {
    var kind: TalkSpeechBackendKind { get }
    var isRunning: Bool { get }

    func startRecognition(eventHandler: @escaping @Sendable (TalkSpeechBackendEvent) -> Void) throws
    func appendAudioBuffer(_ buffer: AVAudioPCMBuffer)
    func stopRecognition()
}

final class AppleTalkSpeechBackend: TalkSpeechBackend {
    private let configuration: TalkSpeechBackendConfiguration
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    init(configuration: TalkSpeechBackendConfiguration) {
        self.configuration = configuration
    }

    let kind: TalkSpeechBackendKind = .apple

    var isRunning: Bool {
        self.recognitionTask != nil || self.recognitionRequest != nil
    }

    func startRecognition(eventHandler: @escaping @Sendable (TalkSpeechBackendEvent) -> Void) throws {
        self.stopRecognition()
        self.speechRecognizer = self.makeRecognizer()
        guard let recognizer = self.speechRecognizer else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable",
            ])
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        self.recognitionRequest = request
        self.recognitionTask = recognizer.recognitionTask(with: request) { result, error in
            if let error {
                let message = error.localizedDescription
                let lowered = message.lowercased()
                let isCancellation = lowered.contains("cancelled") || lowered.contains("canceled")
                eventHandler(.failure(message: message, isCancellation: isCancellation))
            }
            guard let result else { return }
            eventHandler(.transcript(.init(
                transcript: result.bestTranscription.formattedString,
                isFinal: result.isFinal)))
        }
    }

    func appendAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        self.recognitionRequest?.append(buffer)
    }

    func stopRecognition() {
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest?.endAudio()
        self.recognitionRequest = nil
        self.speechRecognizer = nil
    }

    private func makeRecognizer() -> SFSpeechRecognizer? {
        if let language = self.configuration.language?.trimmingCharacters(in: .whitespacesAndNewlines),
           !language.isEmpty,
           let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
        {
            return recognizer
        }
        return SFSpeechRecognizer()
    }
}

final class GatewayTalkSpeechBackend: TalkSpeechBackend {
    private let configuration: TalkSpeechBackendConfiguration

    init(configuration: TalkSpeechBackendConfiguration) {
        self.configuration = configuration
    }

    let kind: TalkSpeechBackendKind = .gateway

    var isRunning: Bool { false }

    func startRecognition(eventHandler _: @escaping @Sendable (TalkSpeechBackendEvent) -> Void) throws {
        let providerLabel = self.configuration.configuredProviderID ?? "gateway"
        throw NSError(domain: "TalkMode", code: 8, userInfo: [
            NSLocalizedDescriptionKey: "Gateway speech backend (provider: \(providerLabel)) is not implemented on iOS yet",
        ])
    }

    func appendAudioBuffer(_: AVAudioPCMBuffer) {}

    func stopRecognition() {}
}

enum TalkSpeechBackendFactory {
    static func make(for configuration: TalkSpeechBackendConfiguration) -> any TalkSpeechBackend {
        switch configuration.kind {
        case .apple:
            AppleTalkSpeechBackend(configuration: configuration)
        case .gateway:
            GatewayTalkSpeechBackend(configuration: configuration)
        }
    }
}
