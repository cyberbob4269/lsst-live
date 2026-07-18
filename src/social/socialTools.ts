// Social domain tools for the agent loop (Phase 5). Appended to the built-in
// AGENT_TOOLS in ChatPanel, so the same Approve/Deny gate applies:
// generate_image / generate_video / postiz_create_draft are "write" tools
// (always approval-gated — they spend API money or touch the Postiz stack);
// postiz_list_channels is a "read" (auto-approvable).
//
// Draft-only guarantee: postiz_create_draft maps to createDraft(), which
// hard-codes type "draft" — there is intentionally NO tool (and no client
// function) that publishes or schedules live. The agentLoop system prompt
// states this explicitly.

import type { AgentTool } from "../agent/tools";
import { generateImage, generateVideo } from "./grokImagine";
import { createDraft, listChannels } from "./postizClient";

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`tool argument "${name}" must be a non-empty string`);
  }
  return v.trim();
}

function stringArray(args: Record<string, unknown>, name: string): string[] {
  const v = args[name];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`tool argument "${name}" must be an array of strings`);
  }
  return v.filter((x): x is string => typeof x === "string" && !!x.trim());
}

export const SOCIAL_TOOLS: AgentTool[] = [
  {
    kind: "write",
    spec: {
      name: "generate_image",
      description:
        "Generate an image with xAI Grok Imagine and save it into the workspace social-media/ dir (recorded in social-media/catalog.json). Spends xAI API credit — always confirm the prompt with the user first.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Visual description of the image." },
          slug: {
            type: "string",
            description: "File slug — saved as social-media/<slug>.png.",
          },
          aspect: {
            type: "string",
            description: "Aspect ratio, e.g. \"9:16\" (default), \"16:9\", \"1:1\".",
          },
        },
        required: ["prompt", "slug"],
      },
    },
    run: async (args) => {
      const prompt = requireString(args, "prompt");
      const slug = requireString(args, "slug");
      const aspect = typeof args.aspect === "string" && args.aspect.trim() ? args.aspect.trim() : undefined;
      const result = await generateImage(prompt, slug, aspect);
      return `image saved to ${result.filePath}`;
    },
  },
  {
    kind: "write",
    spec: {
      name: "generate_video",
      description:
        "Generate a short video with xAI Grok Imagine (async, polls up to ~3 min) and save it into the workspace social-media/ dir (recorded in social-media/catalog.json). Spends xAI API credit — always confirm the prompt with the user first.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Visual description / motion prompt." },
          slug: {
            type: "string",
            description: "File slug — saved as social-media/<slug>.mp4.",
          },
          duration: {
            type: "number",
            description: "Seconds, 1-15 (default 8).",
          },
        },
        required: ["prompt", "slug"],
      },
    },
    run: async (args) => {
      const prompt = requireString(args, "prompt");
      const slug = requireString(args, "slug");
      const duration = typeof args.duration === "number" ? args.duration : undefined;
      const result = await generateVideo(prompt, slug, { duration });
      return `video saved to ${result.filePath}`;
    },
  },
  {
    kind: "read",
    spec: {
      name: "postiz_list_channels",
      description:
        "List the social channels connected to the local Postiz instance (ids needed for postiz_create_draft). Requires the stack running and a Postiz API key.",
      parameters: { type: "object", properties: {} },
    },
    run: async () => {
      const channels = await listChannels();
      if (channels.length === 0) {
        return "No channels connected in Postiz yet — connect one in the Postiz UI (http://localhost:4007).";
      }
      return channels
        .map((c) => `${c.id}  ${c.provider}  ${c.name}${c.disabled ? " (disabled)" : ""}`)
        .join("\n");
    },
  },
  {
    kind: "write",
    spec: {
      name: "postiz_create_draft",
      description:
        "Create a DRAFT post on a Postiz channel. Draft only — this tool can never publish or schedule a live post; a human reviews drafts in the Postiz UI. Use postiz_list_channels to find the channelId.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Full post text." },
          channelId: {
            type: "string",
            description: "Postiz integration/channel id from postiz_list_channels.",
          },
          mediaPaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional workspace paths of media files (e.g. social-media/x.png) to attach; uploaded to Postiz first.",
          },
        },
        required: ["text", "channelId"],
      },
    },
    run: async (args) => {
      const text = requireString(args, "text");
      const channelId = requireString(args, "channelId");
      const mediaPaths = stringArray(args, "mediaPaths");
      return createDraft({ text, mediaPaths, channelId });
    },
  },
];
