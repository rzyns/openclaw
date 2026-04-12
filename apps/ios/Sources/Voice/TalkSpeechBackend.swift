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

    var usesUtteranceBoundaryFinalization: Bool {
        self.kind == .gateway
    }
}

struct TalkSpeechBackendResult: Sendable {
    let transcript: String
    let isFinal: Bool
}

struct TalkSpeechBackendAudioClip: Sendable {
    let data: Data
    let mimeType: String
    let fileExtension: String
}

enum TalkSpeechBackendEvent: Sendable {
    case transcript(TalkSpeechBackendResult)
    case failure(message: String, isCancellation: Bool)
}

protocol TalkSpeechBackend: AnyObject {
    var kind: TalkSpeechBackendKind { get }
    var isRunning: Bool { get }
    var hasBufferedUtteranceAudio: Bool { get }

    func startRecognition(eventHandler: @escaping @Sendable (TalkSpeechBackendEvent) -> Void) throws
    func appendAudioBuffer(_ buffer: AVAudioPCMBuffer)
    func takeBufferedUtteranceAudio() -> TalkSpeechBackendAudioClip?
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

    var hasBufferedUtteranceAudio: Bool { false }

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

    func takeBufferedUtteranceAudio() -> TalkSpeechBackendAudioClip? {
        nil
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

private final class BufferedTalkSpeechAudioClipBuilder: @unchecked Sendable {
    private let lock = NSLock()
    private var sampleRate: Int?
    private var channelCount: UInt16?
    private var pcmData = Data()

    var hasAudio: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return !self.pcmData.isEmpty
    }

    func reset() {
        self.lock.lock()
        self.sampleRate = nil
        self.channelCount = nil
        self.pcmData.removeAll(keepingCapacity: false)
        self.lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        let format = buffer.format
        guard format.sampleRate > 0, format.channelCount > 0 else { return }
        let convertedPCM = Self.convertToPCM16(buffer)
        guard !convertedPCM.isEmpty else { return }

        let sampleRate = Int(format.sampleRate.rounded())
        let channelCount = UInt16(format.channelCount)

        self.lock.lock()
        defer { self.lock.unlock() }

        if let existingSampleRate = self.sampleRate,
           let existingChannelCount = self.channelCount,
           (existingSampleRate != sampleRate || existingChannelCount != channelCount)
        {
            self.pcmData.removeAll(keepingCapacity: false)
        }

        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.pcmData.append(convertedPCM)
    }

    func takeClip() -> TalkSpeechBackendAudioClip? {
        self.lock.lock()
        defer { self.lock.unlock() }
        guard let sampleRate = self.sampleRate,
              let channelCount = self.channelCount,
              !self.pcmData.isEmpty
        else {
            return nil
        }

        let pcmData = self.pcmData
        self.sampleRate = nil
        self.channelCount = nil
        self.pcmData.removeAll(keepingCapacity: false)

        var data = Self.makeWAVHeader(
            pcmByteCount: pcmData.count,
            sampleRate: sampleRate,
            channelCount: channelCount)
        data.append(pcmData)
        return TalkSpeechBackendAudioClip(data: data, mimeType: "audio/wav", fileExtension: "wav")
    }

    private static func convertToPCM16(_ buffer: AVAudioPCMBuffer) -> Data {
        let format = buffer.format
        let channelCount = Int(format.channelCount)
        let frameCount = Int(buffer.frameLength)
        guard channelCount > 0, frameCount > 0 else { return Data() }

        switch format.commonFormat {
        case .pcmFormatFloat32:
            return self.convertFloat32(buffer, channelCount: channelCount, frameCount: frameCount)
        case .pcmFormatInt16:
            return self.convertInt16(buffer, channelCount: channelCount, frameCount: frameCount)
        case .pcmFormatInt32:
            return self.convertInt32(buffer, channelCount: channelCount, frameCount: frameCount)
        default:
            return Data()
        }
    }

    private static func convertFloat32(
        _ buffer: AVAudioPCMBuffer,
        channelCount: Int,
        frameCount: Int) -> Data
    {
        guard let channels = buffer.floatChannelData else { return Data() }
        var data = Data(capacity: frameCount * channelCount * MemoryLayout<Int16>.size)
        if buffer.format.isInterleaved {
            let samples = channels[0]
            let totalSampleCount = frameCount * channelCount
            for sampleIndex in 0 ..< totalSampleCount {
                self.appendPCM16(self.quantize(samples[sampleIndex]), to: &data)
            }
            return data
        }

        for frameIndex in 0 ..< frameCount {
            for channelIndex in 0 ..< channelCount {
                self.appendPCM16(self.quantize(channels[channelIndex][frameIndex]), to: &data)
            }
        }
        return data
    }

    private static func convertInt16(
        _ buffer: AVAudioPCMBuffer,
        channelCount: Int,
        frameCount: Int) -> Data
    {
        guard let channels = buffer.int16ChannelData else { return Data() }
        if buffer.format.isInterleaved {
            let sampleCount = frameCount * channelCount
            let raw = UnsafeRawBufferPointer(
                start: channels[0],
                count: sampleCount * MemoryLayout<Int16>.size)
            return Data(raw)
        }

        var data = Data(capacity: frameCount * channelCount * MemoryLayout<Int16>.size)
        for frameIndex in 0 ..< frameCount {
            for channelIndex in 0 ..< channelCount {
                self.appendPCM16(channels[channelIndex][frameIndex], to: &data)
            }
        }
        return data
    }

    private static func convertInt32(
        _ buffer: AVAudioPCMBuffer,
        channelCount: Int,
        frameCount: Int) -> Data
    {
        guard let channels = buffer.int32ChannelData else { return Data() }
        var data = Data(capacity: frameCount * channelCount * MemoryLayout<Int16>.size)
        if buffer.format.isInterleaved {
            let samples = channels[0]
            let totalSampleCount = frameCount * channelCount
            for sampleIndex in 0 ..< totalSampleCount {
                self.appendPCM16(self.quantize(samples[sampleIndex]), to: &data)
            }
            return data
        }

        for frameIndex in 0 ..< frameCount {
            for channelIndex in 0 ..< channelCount {
                self.appendPCM16(self.quantize(channels[channelIndex][frameIndex]), to: &data)
            }
        }
        return data
    }

    private static func quantize(_ sample: Float) -> Int16 {
        let clamped = max(-1.0, min(1.0, Double(sample)))
        let scale = clamped >= 0 ? Double(Int16.max) : Double(Int16.max) + 1
        let scaled = Int((clamped * scale).rounded())
        return Int16(clamping: scaled)
    }

    private static func quantize(_ sample: Int32) -> Int16 {
        Int16(clamping: Int(sample >> 16))
    }

    private static func appendPCM16(_ sample: Int16, to data: inout Data) {
        var value = sample.littleEndian
        withUnsafeBytes(of: &value) { bytes in
            data.append(contentsOf: bytes)
        }
    }

    private static func appendPCM32(_ sample: UInt32, to data: inout Data) {
        var value = sample.littleEndian
        withUnsafeBytes(of: &value) { bytes in
            data.append(contentsOf: bytes)
        }
    }

    private static func makeWAVHeader(
        pcmByteCount: Int,
        sampleRate: Int,
        channelCount: UInt16) -> Data
    {
        let bitsPerSample: UInt16 = 16
        let blockAlign = UInt16(channelCount * (bitsPerSample / 8))
        let byteRate = UInt32(sampleRate) * UInt32(blockAlign)
        let dataSize = UInt32(pcmByteCount)
        let chunkSize = 36 + dataSize

        var data = Data()
        data.append(Data("RIFF".utf8))
        self.appendPCM32(chunkSize, to: &data)
        data.append(Data("WAVE".utf8))
        data.append(Data("fmt ".utf8))
        self.appendPCM32(16, to: &data)
        self.appendPCM16(1, to: &data)
        self.appendPCM16(Int16(bitPattern: channelCount), to: &data)
        self.appendPCM32(UInt32(sampleRate), to: &data)
        self.appendPCM32(byteRate, to: &data)
        self.appendPCM16(Int16(bitPattern: blockAlign), to: &data)
        self.appendPCM16(Int16(bitPattern: bitsPerSample), to: &data)
        data.append(Data("data".utf8))
        self.appendPCM32(dataSize, to: &data)
        return data
    }
}

final class GatewayTalkSpeechBackend: TalkSpeechBackend {
    private let configuration: TalkSpeechBackendConfiguration
    private let fallbackBackend: AppleTalkSpeechBackend
    private let audioClipBuilder = BufferedTalkSpeechAudioClipBuilder()

    init(configuration: TalkSpeechBackendConfiguration) {
        self.configuration = configuration
        self.fallbackBackend = AppleTalkSpeechBackend(configuration: TalkSpeechBackendConfiguration(
            kind: .apple,
            configuredProviderID: configuration.configuredProviderID,
            language: configuration.language,
            model: configuration.model))
    }

    let kind: TalkSpeechBackendKind = .gateway

    var isRunning: Bool {
        self.fallbackBackend.isRunning
    }

    var hasBufferedUtteranceAudio: Bool {
        self.audioClipBuilder.hasAudio
    }

    func startRecognition(eventHandler: @escaping @Sendable (TalkSpeechBackendEvent) -> Void) throws {
        self.audioClipBuilder.reset()
        try self.fallbackBackend.startRecognition(eventHandler: eventHandler)
    }

    func appendAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        self.audioClipBuilder.append(buffer)
        self.fallbackBackend.appendAudioBuffer(buffer)
    }

    func takeBufferedUtteranceAudio() -> TalkSpeechBackendAudioClip? {
        self.audioClipBuilder.takeClip()
    }

    func stopRecognition() {
        self.fallbackBackend.stopRecognition()
        self.audioClipBuilder.reset()
    }
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
