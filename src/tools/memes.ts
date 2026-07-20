/**
 * Capix MCP Server — meme + image generation tools (3).
 *
 * Thin wrappers over the control-plane content routes (see
 * app/api/v1/memes/route.ts and app/api/v1/images/route.ts in the protocol
 * repo):
 *
 *   capix_meme            POST /api/v1/memes   generate a meme       (billable)
 *   capix_image_gen       POST /api/v1/images  text-to-image         (billable)
 *   capix_meme_templates  GET  /api/v1/memes   template/vibe catalog (read-only)
 *
 * All three are declared with `defineGeneratedTool` (./generate.ts), so the
 * registration and the HTTP dispatch share one spec. The two POSTs are real
 * money-moving mutations — they inherit the generator's defaults for billable
 * specs: an Idempotency-Key derived from path+body and the bound
 * approvalToken header, matching the routes' `Idempotency-Key` requirement.
 *
 * Payload truncation: both POST responses carry large inline artifacts
 * (`svg` markup for memes, `base64` rasters for images). The `transform`
 * hook replaces each artifact with a short omission pointer (share URL /
 * id + the canonical GET /api/v1/memes/:id retrieval route) so the payload
 * itself never floods the agent's context. Captions, prompt, and the
 * `charge` object pass through untouched.
 *
 * This module shares `defineGeneratedTool` with the aggregate registry in
 * ../tools.ts via ./generate.js (a leaf module), so there is no import cycle.
 */

import { z } from "zod";
import { defineGeneratedTool } from "./generate.js";
import { BILLABLE, READ_ONLY } from "../types.js";
import type { ToolDef } from "../types.js";

// ===========================================================================
// Local Zod fragments (mirror tools.ts — keep in sync)
// ===========================================================================

/**
 * Charge envelope returned by the meme/image routes: either a settled
 * balance charge (integer minor units as a string) or a free-tier grant.
 */
const chargeShape = z
  .object({
    kind: z.enum(["free", "balance"]).optional(),
    amountMinor: z
      .string()
      .optional()
      .describe("Integer minor units charged, serialized as a string."),
    asset: z.string().optional(),
    scale: z.number().int().optional(),
    freeUsedToday: z.number().int().optional(),
    freePerDay: z.number().int().optional(),
  })
  .describe("Settled charge for the generation (balance debit or free-tier grant).");

/** Caption voices accepted by POST /api/v1/memes (MEME_VIBES upstream). */
const MEME_VIBE_VALUES = ["degen", "pump", "bagholder", "unhinged", "dev", "spicy"] as const;

// ===========================================================================
// Payload truncation (transform hooks)
// ===========================================================================

/** Replace an oversized inline payload with a short omission pointer. */
function omitPayload(payload: string, pointer: string): string {
  return `[omitted ${payload.length} chars — ${pointer}]`;
}

/**
 * Swap the inline meme SVG for a pointer to the share page / canonical
 * retrieval route. Everything else (captions, charge, ids) passes through.
 */
function truncateMemeResponse(res: Record<string, unknown>): Record<string, unknown> {
  if (typeof res.svg !== "string") return res;
  const memeId = typeof res.memeId === "string" ? res.memeId : "unknown";
  const shareUrl = typeof res.shareUrl === "string" ? res.shareUrl : undefined;
  const pointer = shareUrl
    ? `view at ${shareUrl} or fetch via GET /api/v1/memes/${memeId}`
    : `fetch via GET /api/v1/memes/${memeId}`;
  return { ...res, svg: omitPayload(res.svg, pointer) };
}

/**
 * Swap the inline base64 raster for a pointer to the image id. The image is
 * persisted server-side and retrievable via GET /api/v1/memes/:id.
 */
function truncateImageResponse(res: Record<string, unknown>): Record<string, unknown> {
  if (typeof res.base64 !== "string") return res;
  const imageId = typeof res.imageId === "string" ? res.imageId : "unknown";
  return {
    ...res,
    base64: omitPayload(res.base64, `imageId ${imageId} — fetch via GET /api/v1/memes/${imageId}`),
  };
}

// ===========================================================================
// Meme + image tools (3)
// ===========================================================================

export const memeImageTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_meme",
    description:
      "Generate a meme from a topic: template captions, or a fully AI-generated canvas image. " +
      "The account gets a small free daily allowance, then a fixed balance charge; omitting " +
      "templateId (or passing \"ai-canvas\") generates the image with AI at 2x the template " +
      "price. Returns the meme id, captions, shareUrl, and the settled charge; the inline SVG " +
      "is replaced with a pointer to the share URL. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/memes",
    input: {
      topic: z.string().min(1).describe("What the meme is about."),
      vibe: z
        .enum(MEME_VIBE_VALUES)
        .optional()
        .describe("Caption voice (see capix_meme_templates for the live catalog)."),
      templateId: z
        .string()
        .optional()
        .describe(
          "Template id from capix_meme_templates. Omit (or pass \"ai-canvas\") for a fully " +
            "AI-generated image at 2x the template price.",
        ),
    },
    outputShape: {
      memeId: z.string().optional(),
      svg: z
        .string()
        .optional()
        .describe("Omission pointer — the full SVG is at shareUrl / GET /api/v1/memes/:id."),
      caption: z.string().optional(),
      captions: z.record(z.string()).optional(),
      templateId: z.string().optional(),
      vibe: z.string().optional(),
      mode: z.string().optional(),
      shareUrl: z.string().optional(),
      charge: chargeShape.optional(),
    },
    transform: truncateMemeResponse,
  }),
  defineGeneratedTool({
    name: "capix_image_gen",
    description:
      "Generate an image from a text prompt (fixed per-image balance charge, no free tier). " +
      "Returns the image id, content type, and the settled charge; the base64 payload is " +
      "replaced with a pointer to the retrievable image id. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/images",
    input: {
      prompt: z
        .string()
        .min(2)
        .max(1000)
        .describe("Image prompt (2–1000 characters, per the control-plane limit)."),
    },
    outputShape: {
      imageId: z.string().optional(),
      base64: z
        .string()
        .optional()
        .describe("Omission pointer — the full image is retrievable via GET /api/v1/memes/:id."),
      contentType: z.string().optional(),
      prompt: z.string().optional(),
      charge: chargeShape.optional(),
    },
    transform: truncateImageResponse,
  }),
  defineGeneratedTool({
    name: "capix_meme_templates",
    description:
      "List the meme catalog: available templates (ids, slots, hints), caption vibes, and " +
      "whether AI-canvas image generation is currently available. Free; read-only.",
    scope: "discovery",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/memes",
    input: {},
    outputShape: {
      templates: z.array(z.record(z.unknown())).optional(),
      vibes: z.array(z.string()).optional(),
      aiCanvasAvailable: z.boolean().optional(),
    },
  }),
];

export const MEME_IMAGE_TOOL_NAMES: string[] = memeImageTools.map((t) => t.name);
