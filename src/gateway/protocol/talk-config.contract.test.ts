import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateTalkConfigResult } from "./index.js";

type ExpectedSelection = {
  provider: string;
  normalizedPayload: boolean;
  voiceId?: string;
  apiKey?: string;
};

type SelectionContractCase = {
  id: string;
  defaultProvider: string;
  payloadValid: boolean;
  expectedSelection: ExpectedSelection | null;
  talk: Record<string, unknown>;
};

type TimeoutContractCase = {
  id: string;
  fallback: number;
  expectedTimeoutMs: number;
  talk: Record<string, unknown>;
};

type SttContractCase = {
  id: string;
  defaultSttProvider: string;
  expectedSttProvider: string;
  expectedSttLanguage?: string;
  expectedSttModel?: string;
  talk: Record<string, unknown>;
};

type TalkConfigContractFixture = {
  selectionCases: SelectionContractCase[];
  timeoutCases: TimeoutContractCase[];
  sttCases?: SttContractCase[];
};

const fixturePath = new URL("../../../test-fixtures/talk-config-contract.json", import.meta.url);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as TalkConfigContractFixture;

describe("talk.config contract fixtures", () => {
  for (const fixture of fixtures.selectionCases) {
    it(fixture.id, () => {
      const payload = { config: { talk: fixture.talk } };
      if (fixture.payloadValid) {
        expect(validateTalkConfigResult(payload)).toBe(true);
      } else {
        expect(validateTalkConfigResult(payload)).toBe(false);
      }

      if (!fixture.expectedSelection) {
        return;
      }

      const talk = payload.config.talk as
        | {
            resolved?: {
              provider?: string;
              config?: {
                voiceId?: string;
                apiKey?: string;
              };
            };
          }
        | undefined;
      expect(talk?.resolved?.provider ?? fixture.defaultProvider).toBe(
        fixture.expectedSelection.provider,
      );
      expect(talk?.resolved?.config?.voiceId).toBe(fixture.expectedSelection.voiceId);
      expect(talk?.resolved?.config?.apiKey).toBe(fixture.expectedSelection.apiKey);
    });
  }

  for (const fixture of fixtures.timeoutCases) {
    it(`timeout:${fixture.id}`, () => {
      const payload = fixture.talk as { silenceTimeoutMs?: number } | undefined;
      expect(payload?.silenceTimeoutMs ?? fixture.fallback).toBe(fixture.expectedTimeoutMs);
    });
  }

  for (const fixture of fixtures.sttCases ?? []) {
    it(`stt:${fixture.id}`, () => {
      const payload = { config: { talk: fixture.talk } };
      expect(validateTalkConfigResult(payload)).toBe(true);

      const talk = payload.config.talk as
        | {
            resolvedStt?: {
              provider?: string;
              config?: {
                language?: string;
                model?: string;
              };
            };
          }
        | undefined;
      expect(talk?.resolvedStt?.provider ?? fixture.defaultSttProvider).toBe(
        fixture.expectedSttProvider,
      );
      expect(talk?.resolvedStt?.config?.language).toBe(fixture.expectedSttLanguage);
      expect(talk?.resolvedStt?.config?.model).toBe(fixture.expectedSttModel);
    });
  }
});
