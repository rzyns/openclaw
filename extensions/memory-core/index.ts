import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMemoryCli } from "./src/cli.js";
import { registerDreamingCommand } from "./src/dreaming-command.js";
import { registerShortTermPromotionDreaming } from "./src/dreaming.js";
import {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./src/memory/provider-adapters.js";
import { buildPromptSection } from "./src/prompt-section.js";
import { listMemoryCorePublicArtifacts } from "./src/public-artifacts.js";
import { memoryRuntime } from "./src/runtime-provider.js";
import { createMemoryGetTool, createMemorySearchTool } from "./src/tools.js";
export {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
export { buildPromptSection } from "./src/prompt-section.js";

export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    const dbg = process.env.OPENCLAW_DEBUG_PLUGIN_SCOPE === "1";
    const step = (n: number, label: string) => {
      if (dbg) {
        // eslint-disable-next-line no-console
        console.warn(`[memory-core-register-probe] step=${n} ${label}`);
      }
    };
    try {
      step(0, "enter");
      registerBuiltInMemoryEmbeddingProviders(api);
      step(1, "after registerBuiltInMemoryEmbeddingProviders");
      registerShortTermPromotionDreaming(api);
      step(2, "after registerShortTermPromotionDreaming");
      registerDreamingCommand(api);
      step(3, "after registerDreamingCommand");
      api.registerMemoryCapability({
        promptBuilder: buildPromptSection,
        flushPlanResolver: buildMemoryFlushPlan,
        runtime: memoryRuntime,
        publicArtifacts: {
          listArtifacts: listMemoryCorePublicArtifacts,
        },
      });
      step(4, "after registerMemoryCapability");

      api.registerTool(
        (ctx) =>
          createMemorySearchTool({
            config: ctx.config,
            agentSessionKey: ctx.sessionKey,
          }),
        { names: ["memory_search"] },
      );
      step(5, "after registerTool memory_search");

      api.registerTool(
        (ctx) =>
          createMemoryGetTool({
            config: ctx.config,
            agentSessionKey: ctx.sessionKey,
          }),
        { names: ["memory_get"] },
      );
      step(6, "after registerTool memory_get");

      api.registerCli(
        ({ program }) => {
          registerMemoryCli(program);
        },
        {
          descriptors: [
            {
              name: "memory",
              description: "Search, inspect, and reindex memory files",
              hasSubcommands: true,
            },
          ],
        },
      );
      step(7, "after registerCli (exit)");
    } catch (err) {
      if (dbg) {
        // eslint-disable-next-line no-console
        console.warn(
          `[memory-core-register-probe] THREW ${
            err instanceof Error
              ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
              : String(err)
          }`,
        );
      }
      throw err;
    }
  },
});
