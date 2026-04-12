import Foundation
import OpenClawKit

struct TalkModeGatewayConfigState {
    let activeProvider: String
    let normalizedPayload: Bool
    let missingResolvedPayload: Bool
    let defaultVoiceId: String?
    let voiceAliases: [String: String]
    let defaultModelId: String
    let defaultOutputFormat: String?
    let rawConfigApiKey: String?
    let interruptOnSpeech: Bool?
    let silenceTimeoutMs: Int
    // STT config
    let activeSttProvider: String
    let sttLanguage: String?
    let sttModel: String?
    let sttBackend: TalkSpeechBackendConfiguration
}

enum TalkModeGatewayConfigParser {
    private static let appleSttProviderAliases: Set<String> = ["apple", "ios", "system"]
    private static let gatewaySttProviderAliases: Set<String> = ["gateway"]

    static func parse(
        config: [String: Any],
        defaultProvider: String,
        defaultSttProvider: String,
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int
    ) -> TalkModeGatewayConfigState {
        let talk = TalkConfigParsing.bridgeFoundationDictionary(config["talk"] as? [String: Any])
        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: defaultProvider,
            allowLegacyFallback: false)
        let activeProvider = selection?.provider ?? defaultProvider
        let activeConfig = selection?.config
        let defaultVoiceId = activeConfig?["voiceId"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let voiceAliases: [String: String]
        if let aliases = activeConfig?["voiceAliases"]?.dictionaryValue {
            var resolved: [String: String] = [:]
            for (key, value) in aliases {
                guard let id = value.stringValue else { continue }
                let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedKey.isEmpty, !trimmedId.isEmpty else { continue }
                resolved[normalizedKey] = trimmedId
            }
            voiceAliases = resolved
        } else {
            voiceAliases = [:]
        }
        let model = activeConfig?["modelId"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultModelId = (model?.isEmpty == false) ? model! : defaultModelIdFallback
        let defaultOutputFormat = activeConfig?["outputFormat"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawConfigApiKey = activeConfig?["apiKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let interruptOnSpeech = talk?["interruptOnSpeech"]?.boolValue
        let silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(
            talk,
            fallback: defaultSilenceTimeoutMs)

        let sttSelection = TalkConfigParsing.selectSttProviderConfig(
            talk,
            defaultProvider: defaultSttProvider,
            allowLegacyFallback: false)
        let sttConfig = sttSelection?.config
        let sttLanguage = sttConfig?["language"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sttModel = sttConfig?["model"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let configuredSttProviderID = self.normalizedProviderID(
            sttSelection?.provider
                ?? talk?["sttProvider"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines))
        let activeSttProvider = configuredSttProviderID ?? defaultSttProvider
        let sttBackend = self.resolveSttBackend(
            configuredProviderID: configuredSttProviderID,
            language: sttLanguage,
            model: sttModel)

        return TalkModeGatewayConfigState(
            activeProvider: activeProvider,
            normalizedPayload: selection?.normalizedPayload == true,
            missingResolvedPayload: talk != nil && selection == nil,
            defaultVoiceId: defaultVoiceId,
            voiceAliases: voiceAliases,
            defaultModelId: defaultModelId,
            defaultOutputFormat: defaultOutputFormat,
            rawConfigApiKey: rawConfigApiKey,
            interruptOnSpeech: interruptOnSpeech,
            silenceTimeoutMs: silenceTimeoutMs,
            activeSttProvider: activeSttProvider,
            sttLanguage: sttLanguage,
            sttModel: sttModel,
            sttBackend: sttBackend)
    }

    private static func normalizedProviderID(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func resolveSttBackend(
        configuredProviderID: String?,
        language: String?,
        model: String?
    ) -> TalkSpeechBackendConfiguration {
        guard let providerID = configuredProviderID else { return .appleDefault }
        let kind: TalkSpeechBackendKind
        if self.gatewaySttProviderAliases.contains(providerID) {
            kind = .gateway
        } else {
            kind = .apple
        }
        let normalizedProviderID = self.appleSttProviderAliases.contains(providerID)
            ? "apple"
            : providerID
        return TalkSpeechBackendConfiguration(
            kind: kind,
            configuredProviderID: normalizedProviderID,
            language: language,
            model: model)
    }
}
