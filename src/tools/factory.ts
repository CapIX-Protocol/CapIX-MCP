/**
 * Capix MCP Server — factory tools (14): durable jobs, training runs, and
 * agent deploys. Added in the 2026-07 repair; every tool targets a route
 * family that exists in the control plane (see ../route-families.ts):
 *
 *   jobs (6)          app/api/v1/jobs/*
 *     capix_job_submit    POST /api/v1/jobs                  (billable, idempotent)
 *     capix_job_list      GET  /api/v1/jobs                  (read-only)
 *     capix_job_get       GET  /api/v1/jobs?id=<jobId>       (read-only — there is
 *                         NO /api/v1/jobs/[id] route; detail is a query param)
 *     capix_job_logs      GET  /api/v1/jobs/:id/logs         (read-only, `after` seq cursor)
 *     capix_job_cancel    POST /api/v1/jobs/:id/cancel       (cooperative cancel flag)
 *     capix_job_rerun     POST /api/v1/jobs/:id/rerun        (billable, idempotent)
 *
 *   training (4)      app/api/v1/training/*
 *     capix_training_submit  POST /api/v1/training           (billable, idempotent)
 *     capix_training_list    GET  /api/v1/training           (read-only)
 *     capix_training_get     GET  /api/v1/training/:id       (read-only)
 *     capix_training_deploy  POST /api/v1/training/:id/deploy (handoff deep-link,
 *                         NOT a completed deployment — see the tool description)
 *
 *   agent deploys (4) app/api/v1/agent-deploys/*
 *     capix_agent_deploy   POST   /api/v1/agent-deploys      (billable, idempotent)
 *     capix_agent_list     GET    /api/v1/agent-deploys      (read-only)
 *     capix_agent_get      GET    /api/v1/agent-deploys/:id  (read-only)
 *     capix_agent_destroy  DELETE /api/v1/agent-deploys/:id  (destructive; refund settles)
 *
 * All fourteen are declared with `defineGeneratedTool` (./generate.ts), so the
 * registration and the HTTP dispatch share one spec. Mutation specs inherit
 * the generator's conventions: Idempotency-Key + bound approvalToken on
 * billable/approval POSTs (all three submit routes REQUIRE the Idempotency-Key
 * header upstream), and the client-derived key on DELETEs. The upstream error
 * code style differs per family (jobs/training: CAPIX_*; agent-deploys:
 * snake_case) — both pass through untouched as problem+json.
 *
 * This module shares `defineGeneratedTool` with the aggregate registry in
 * ../tools.ts via ./generate.js (a leaf module), so there is no import cycle.
 */

import { z } from "zod";
import { defineGeneratedTool } from "./generate.js";
import { APPROVAL_ONLY, BILLABLE, READ_ONLY } from "../types.js";
import type { ToolDef } from "../types.js";

// ===========================================================================
// Local Zod fragments (mirror tools.ts — keep in sync)
// ===========================================================================

const jobIdShape = z.string().describe("Durable job id (job_…).");
const trainingIdShape = z.string().describe("Training run id.");
const agentDeployIdShape = z.string().describe("Agent deployment id.");

/** DurableJob envelope (CapIX-Backend/lib/serverless-queue.ts). */
const jobResultShape = {
  job: z.record(z.unknown()).optional().describe(
    "DurableJob: id, accountId, projectId, status (queued|leased|running|succeeded|failed|canceled|dead_letter), " +
      "image, command, tierId, timeoutSeconds, attempt, result, error, createdAt, updatedAt.",
  ),
} satisfies Record<string, z.ZodTypeAny>;

/** TrainingRunView envelope (CapIX-Backend/lib/training/index.ts). */
const trainingResultShape = {
  training: z.record(z.unknown()).optional().describe(
    "TrainingRunView: trainingId, status (queued|running|finalizing|artifact_ready|deploy_pending|failed|canceled), " +
      "baseModel, outputName, lora, dataset, tier, estimate, progress, jobId, trainedModel, deployPath, createdAt, updatedAt.",
  ),
} satisfies Record<string, z.ZodTypeAny>;

/** PublicAgentDeploy envelope (CapIX-Backend/lib/agentDeploys.ts). */
const agentDeployResultShape = {
  deployment: z.record(z.unknown()).optional().describe(
    "PublicAgentDeploy: id, name, runtime, image, model, tier, durationHours, " +
      "status (queued|provisioning|configuring|ready|failed|destroying|destroyed), agentUrl, price, createdAt, readyAt.",
  ),
} satisfies Record<string, z.ZodTypeAny>;

// ===========================================================================
// Jobs (6)
// ===========================================================================

const jobTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_job_submit",
    description:
      "Submit a durable batch job (container image + command) to the serverless queue. " +
      "Idempotent — the control plane derives the job id from the Idempotency-Key, so " +
      "replays return the same job. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/jobs",
    input: {
      image: z.string().min(1).describe("Container image to run (required by the route)."),
      command: z.array(z.string()).min(1).describe("Command argv (required, non-empty)."),
      tierId: z.string().optional().describe("Optional compute tier id."),
      timeoutSeconds: z.number().int().positive().optional(),
      projectId: z.string().optional().describe("Project id; must match the caller's membership."),
    },
    outputShape: jobResultShape,
  }),
  defineGeneratedTool({
    name: "capix_job_list",
    description: "List the account's durable jobs. Read-only.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/jobs",
    input: {},
    outputShape: {
      jobs: z.array(z.record(z.unknown())).optional().describe("DurableJob array (unpaginated upstream)."),
    },
  }),
  defineGeneratedTool({
    name: "capix_job_get",
    description:
      "Get a single durable job by id. Read-only. Dispatches to GET /api/v1/jobs?id=<jobId> — " +
      "the control plane has no /api/v1/jobs/[id] route; detail is a query parameter.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/jobs",
    input: {
      id: jobIdShape,
    },
    outputShape: jobResultShape,
  }),
  defineGeneratedTool({
    name: "capix_job_logs",
    description:
      "Fetch job log chunks after a sequence cursor. Read-only. Re-poll with " +
      "`after` set to the returned `nextAfter` to tail.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/jobs/:id/logs",
    input: {
      id: jobIdShape,
      after: z.number().int().min(0).default(0).describe("Seq cursor — only chunks with seq > after are returned."),
      limit: z.number().int().min(1).max(5000).default(1000).describe("Max chunks (upstream cap 5000)."),
    },
    outputShape: {
      job: z.record(z.unknown()).optional().describe("Job subset: id, status, result, error."),
      logs: z.array(z.record(z.unknown())).optional().describe("JobLogChunk: seq, stream (stdout|stderr|system), chunk, createdAt."),
      nextAfter: z.number().int().optional().describe("Cursor for the next poll."),
    },
  }),
  defineGeneratedTool({
    name: "capix_job_cancel",
    description:
      "Request cooperative cancellation of a queued/running job (sets the cancel flag; " +
      "not immediate termination). 409 if the job is already terminal. Requires approval.",
    scope: "lifecycle",
    ...APPROVAL_ONLY,
    method: "POST",
    path: "/api/v1/jobs/:id/cancel",
    input: {
      id: jobIdShape,
    },
    outputShape: {
      ok: z.boolean().optional(),
      jobId: jobIdShape.optional(),
      status: z.string().optional().describe("cancel_requested or the current status."),
    },
  }),
  defineGeneratedTool({
    name: "capix_job_rerun",
    description:
      "Re-enqueue a terminal job with the same image/command/tier/timeout. The parent must " +
      "be in a terminal state (409 otherwise). Idempotent. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/jobs/:id/rerun",
    input: {
      id: jobIdShape.describe("Terminal parent job id."),
    },
    outputShape: {
      ...jobResultShape,
      rerunOf: z.string().optional().describe("Parent job id."),
    },
  }),
];

// ===========================================================================
// Training (4)
// ===========================================================================

/** Base models accepted by POST /api/v1/training (allowlist upstream). */
const TRAINING_BASE_MODELS = [
  "llama-3.2-1b-instruct",
  "llama-3.2-3b-instruct",
  "qwen2.5-3b-instruct",
  "qwen2.5-7b-instruct",
  "mistral-7b-instruct-v0.3",
  "llama-3.1-8b-instruct",
] as const;

const trainingTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_training_submit",
    description:
      "Submit a LoRA fine-tuning run against an allow-listed base model. Takes a ledger " +
      "hold for the high cost estimate. Idempotent. Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/training",
    input: {
      baseModel: z.enum(TRAINING_BASE_MODELS).describe("Allow-listed base model."),
      outputName: z
        .string()
        .max(64)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "outputName must start alphanumeric; letters, digits, . _ - only")
        .describe("Name for the trained adapter (≤64 chars)."),
      dataset: z
        .union([
          z.object({ url: z.string().regex(/^https:\/\/\S+$/i, "dataset.url must be an https URL") }),
          z.object({
            inlineJsonl: z
              .string()
              .max(5 * 1024 * 1024)
              .describe("JSONL chat samples ({messages:[…]} per line; 50–10,000 valid samples, ≤5 MiB)."),
          }),
        ])
        .describe("Exactly one of { url } or { inlineJsonl }."),
      method: z.literal("lora").optional().describe("Only \"lora\" is accepted upstream."),
      lora: z
        .object({
          rank: z.number().int().min(4).max(64).default(16),
          alpha: z.number().int().min(8).max(128).default(32),
          epochs: z.number().int().min(1).max(10).default(3),
          learningRate: z.number().min(1e-6).max(1e-3).default(2e-4),
        })
        .optional()
        .describe("LoRA hyperparameters (upstream defaults shown)."),
      projectId: z.string().optional(),
    },
    outputShape: trainingResultShape,
  }),
  defineGeneratedTool({
    name: "capix_training_list",
    description: "List the account's training runs (lazily reconciled against jobs). Read-only.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/training",
    input: {},
    outputShape: {
      trainings: z.array(z.record(z.unknown())).optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_training_get",
    description: "Get a training run by id (the completion/polling path). Read-only.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/training/:id",
    input: {
      id: trainingIdShape,
    },
    outputShape: trainingResultShape,
  }),
  defineGeneratedTool({
    name: "capix_training_deploy",
    description:
      "Deploy a finished training run. IMPORTANT: the control plane returns a handoff " +
      "deep-link ({ deploy: { status: \"handoff\", path } }) into the private-model deploy " +
      "flow — it does NOT create a deployment by itself. Only runs in artifact_ready " +
      "(409 otherwise); replaying while deploy_pending returns the same handoff. " +
      "Idempotent; requires approval.",
    scope: "lifecycle",
    ...APPROVAL_ONLY,
    method: "POST",
    path: "/api/v1/training/:id/deploy",
    input: {
      id: trainingIdShape.describe("Training run id in artifact_ready status."),
    },
    outputShape: {
      ...trainingResultShape,
      deploy: z
        .object({
          status: z.string().optional().describe("\"handoff\" — follow `path` to complete the deploy."),
          path: z.string().optional().describe("Deep-link into the private-model deploy flow."),
        })
        .optional(),
    },
  }),
];

// ===========================================================================
// Agent deploys (4)
// ===========================================================================

const agentDeployTools: ToolDef[] = [
  defineGeneratedTool({
    name: "capix_agent_deploy",
    description:
      "Deploy a hosted agent runtime (openclaw / hermes / custom image) on a dedicated tier " +
      "for a prepaid duration. Mints a project API key (shown ONCE in mintedKey — idempotent " +
      "replays return it redacted). Billable; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "POST",
    path: "/api/v1/agent-deploys",
    input: {
      runtime: z.enum(["openclaw", "hermes", "custom"]).describe("Agent runtime."),
      customImage: z.string().optional().describe("Container image — required iff runtime is \"custom\"."),
      model: z
        .string()
        .optional()
        .describe("Model id from capix_model_list, \"auto\" (default), or private/<deploymentId> for an owned ready private endpoint."),
      keyMode: z
        .enum(["mint", "provided"])
        .optional()
        .describe("\"mint\" (default) creates a fresh key; \"provided\" requires providedKey."),
      providedKey: z.string().optional().describe("Existing cpxk_ project key — required iff keyMode is \"provided\"."),
      tier: z.enum(["nano", "micro", "standard", "pro"]).describe("Dedicated tier (enterprise excluded upstream)."),
      name: z.string().min(1).max(48).describe("Deployment name (sanitized to [a-z0-9-] upstream)."),
      durationHours: z
        .number()
        .positive()
        .max(168)
        .default(1)
        .describe("Prepaid duration in hours (default 1, max 168 = 7 days)."),
      projectId: z.string().optional(),
    },
    outputShape: {
      ...agentDeployResultShape,
      mintedKey: z
        .record(z.unknown())
        .nullable()
        .optional()
        .describe("{ apiKey, keyId, prefix } — shown once; null/redacted on idempotent replay."),
      gatewayToken: z.string().optional().describe("Gateway token (redacted on replay)."),
      keyWarning: z.string().optional(),
    },
  }),
  defineGeneratedTool({
    name: "capix_agent_list",
    description: "List the account's agent deployments. Read-only.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/agent-deploys",
    input: {
      projectId: z.string().optional(),
    },
    outputShape: {
      data: z.array(z.record(z.unknown())).optional().describe("PublicAgentDeploy array (upstream key is `data`)."),
    },
  }),
  defineGeneratedTool({
    name: "capix_agent_get",
    description:
      "Get an agent deployment by id; lazily advances the provisioning state machine. Read-only.",
    scope: "lifecycle",
    ...READ_ONLY,
    method: "GET",
    path: "/api/v1/agent-deploys/:id",
    input: {
      id: agentDeployIdShape,
    },
    outputShape: {
      ...agentDeployResultShape,
      logsTail: z.unknown().nullable().optional().describe("Recent agent logs when available."),
    },
  }),
  defineGeneratedTool({
    name: "capix_agent_destroy",
    description:
      "Destroy an agent deployment: tears down the VM, revokes the minted key, and releases " +
      "the uncaptured ledger hold (refund settles money). Destructive; requires approval.",
    scope: "lifecycle",
    ...BILLABLE,
    method: "DELETE",
    path: "/api/v1/agent-deploys/:id",
    input: {
      id: agentDeployIdShape,
    },
    outputShape: agentDeployResultShape,
  }),
];

// ===========================================================================
// Aggregate export
// ===========================================================================

export const factoryTools: ToolDef[] = [
  ...jobTools,
  ...trainingTools,
  ...agentDeployTools,
];

export const FACTORY_TOOL_NAMES: string[] = factoryTools.map((t) => t.name);
