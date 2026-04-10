import Foundation
import OpenClawKit
import Testing

private struct TalkConfigContractFixture: Decodable {
    let selectionCases: [SelectionCase]
    let timeoutCases: [TimeoutCase]
    let sttCases: [SttCase]?

    struct SelectionCase: Decodable {
        let id: String
        let defaultProvider: String
        let payloadValid: Bool
        let expectedSelection: ExpectedSelection?
        let talk: [String: AnyCodable]
    }

    struct ExpectedSelection: Decodable {
        let provider: String
        let normalizedPayload: Bool
        let voiceId: String?
        let apiKey: String?
    }

    struct TimeoutCase: Decodable {
        let id: String
        let fallback: Int
        let expectedTimeoutMs: Int
        let talk: [String: AnyCodable]
    }

    struct SttCase: Decodable {
        let id: String
        let defaultSttProvider: String
        let talk: [String: AnyCodable]
        let expectedSttProvider: String
        let expectedSttLanguage: String?
        let expectedSttModel: String?
    }
}

private enum TalkConfigContractFixtureLoader {
    static func load() throws -> TalkConfigContractFixture {
        let fixtureURL = try self.findFixtureURL(startingAt: URL(fileURLWithPath: #filePath))
        let data = try Data(contentsOf: fixtureURL)
        return try JSONDecoder().decode(TalkConfigContractFixture.self, from: data)
    }

    private static func findFixtureURL(startingAt fileURL: URL) throws -> URL {
        var directory = fileURL.deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("test-fixtures/talk-config-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "TalkConfigContractFixtureLoader", code: 1)
    }
}

struct TalkConfigContractTests {
    @Test func selectionFixtures() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().selectionCases {
            let selection = TalkConfigParsing.selectProviderConfig(
                fixture.talk,
                defaultProvider: fixture.defaultProvider)
            if let expected = fixture.expectedSelection {
                #expect(selection != nil)
                #expect(selection?.provider == expected.provider)
                #expect(selection?.normalizedPayload == expected.normalizedPayload)
                #expect(selection?.config["voiceId"]?.stringValue == expected.voiceId)
                #expect(selection?.config["apiKey"]?.stringValue == expected.apiKey)
            } else {
                #expect(selection == nil)
            }
            #expect(fixture.payloadValid == (selection != nil))
        }
    }

    @Test func timeoutFixtures() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().timeoutCases {
            #expect(
                TalkConfigParsing.resolvedSilenceTimeoutMs(
                    fixture.talk,
                    fallback: fixture.fallback) == fixture.expectedTimeoutMs,
                "\(fixture.id)")
        }
    }

    @Test func sttFixtures() throws {
        guard let sttCases = try TalkConfigContractFixtureLoader.load().sttCases else { return }
        for fixture in sttCases {
            let selection = TalkConfigParsing.selectSttProviderConfig(
                fixture.talk,
                defaultProvider: fixture.defaultSttProvider)
            #expect(selection?.provider == fixture.expectedSttProvider, "\(fixture.id)")
            #expect(selection?.config["language"]?.stringValue == fixture.expectedSttLanguage, "\(fixture.id)")
            #expect(selection?.config["model"]?.stringValue == fixture.expectedSttModel, "\(fixture.id)")
        }
    }
}
