// X-intelligence domain tools for the agent loop (Round 9A). Appended to the
// built-in AGENT_TOOLS in ChatPanel next to the social tools, so the same
// Approve/Deny gate applies: both tools are "write" (always approval-gated —
// they spend xAI API credit on Grok Responses API calls whose server-side X
// MCP tools search/analyze X). Executors surface a clean error when no xAI
// key is stored (xintel.ts: "add your xAI key in Settings").

import type { AgentTool } from "../agent/tools";
import { SWEEP_DEFS } from "./sweepDefs";
import { xintelAsk, xintelSweep } from "./xintel";

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`tool argument "${name}" must be a non-empty string`);
  }
  return v.trim();
}

export const XINTEL_TOOLS: AgentTool[] = [
  {
    kind: "write",
    spec: {
      name: "xintel_ask",
      description:
        "Ask Grok to search and analyze X (Twitter) live — one xAI Responses API call whose server-side X MCP tools do the searching. Spends xAI API credit — always confirm the question with the user first.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The X-intelligence question to research, in plain language.",
          },
        },
        required: ["question"],
      },
    },
    run: async (args) => xintelAsk(requireString(args, "question")),
  },
  {
    kind: "write",
    spec: {
      name: "xintel_sweep",
      description:
        `Run all ${SWEEP_DEFS.length} curated X-intelligence sweeps (solar system, missions, Vera Rubin/LSST, telescopes, astronomy buzz, watchlist accounts) via Grok + the X MCP server, sequentially. Spends xAI API credit — always confirm with the user first. Returns a compact JSON summary per topic.`,
      parameters: { type: "object", properties: {} },
    },
    run: async () => {
      const results = await xintelSweep(SWEEP_DEFS);
      // Compact per-topic digest for the model context; the full results are
      // what the Signals view renders/persists.
      const compact = results.map((r) => ({
        topic: r.topic,
        relevanceScore: r.relevanceScore,
        summary: r.error ? `ERROR: ${r.error}` : r.summary.slice(0, 400),
        posts: r.posts.slice(0, 3).map((p) => ({
          author: p.author,
          likes: p.likes,
          retweets: p.retweets,
          url: p.url,
        })),
      }));
      return JSON.stringify(compact, null, 2);
    },
  },
];
