#!/usr/bin/env node
/**
 * Capix MCP Server — deploy and manage private LLM instances on the Capix
 * GPU network from any AI coding agent that supports MCP.
 *
 * Tools:
 *   capix_list_models        — browse the model catalog (featured + uncensored + community)
 *   capix_list_offers        — find live GPU offers that fit a model
 *   capix_deploy_llm         — deploy a model on a GPU, get an OpenAI endpoint back
 *   capix_deploy_custom      — deploy any Hugging Face model (auto-detect specs)
 *   capix_deploy_and_wait    — deploy + poll until ready, return the endpoint + key
 *   capix_list_deploys       — list your active/destroyed LLM deploys
 *   capix_get_endpoint       — get the live endpoint URL + API key for a deploy
 *   capix_destroy_llm        — destroy a deploy and stop billing
 *   capix_get_balance        — check wallet balance + active billing
 *   capix_list_hosted        — list always-on Capix-hosted endpoints (ready now)
 *   capix_reveal_hosted_key  — get the API key for a hosted endpoint
 *
 * Transport: stdio (for local agent integration) or HTTP (for remote).
 *
 * Config via env:
 *   CAPIX_BASE_URL  — Capix network URL (default: https://capix.network)
 *   CAPIX_API_KEY   — Session token (cpx_session.… or cpk_… API key)
 *
 * License: Apache-2.0
 * Repo: https://github.com/CapIX-Protocol/CapIX-MCP
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as capix from "./capixClient.js";

const server = new McpServer({
  name: "capix-mcp-server",
  version: "1.0.0",
});

// ── Tool: List models ──────────────────────────────────────────────────────

server.registerTool(
  "capix_list_models",
  {
    title: "List Capix LLM Models",
    description: `Browse the Capix LLM model catalog. Returns all deployable models including:
- Featured partner models (SuperGemma, Jiunsong uncensored)
- Community models (Qwen, Llama, Mistral, DeepSeek)
- Custom deploy option

Each model includes: id, label, params (B), min VRAM (GB), GPU count,
quantization, whether it's gated (needs HF token), and whether it's
uncensored (no safety filters).

Use this to find the right model before calling capix_deploy_llm.`,
    inputSchema: {
      category: z.string().optional().describe("Filter by category: 'chat', 'coding', 'reasoning', 'vision'"),
      uncensored_only: z.boolean().optional().describe("Show only uncensored/abliterated models (no safety filters)"),
      featured_only: z.boolean().optional().describe("Show only featured partner models"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set. Get your session token from capix.network." }] };
    }

    const models = await capix.getCatalog();
    let filtered = models;

    if (params.category) filtered = filtered.filter((m) => m.category === params.category);
    if (params.uncensored_only) filtered = filtered.filter((m) => m.uncensored);
    if (params.featured_only) filtered = filtered.filter((m) => m.featured || m.partner);

    const lines = filtered.map((m) =>
      `${m.id}\t${m.label}\t${m.paramB}B\t${m.minVramGb}GB VRAM\t${m.gpuCount} GPU${m.gpuCount > 1 ? "s" : ""}\t${m.quantization === "none" ? "fp16" : m.quantization}\t${m.gated ? "gated" : "open"}\t${m.uncensored ? "uncensored" : "standard"}\t${m.tagline}`
    );

    const text = `Model ID\tLabel\tParams\tMin VRAM\tGPUs\tQuant\tAccess\tType\tTagline\n${lines.join("\n")}`;
    const output = { count: filtered.length, models: filtered };

    return {
      content: [{ type: "text", text }],
      structuredContent: output as unknown as Record<string, unknown>,
    };
  },
);

// ── Tool: List offers ───────────────────────────────────────────────────────

server.registerTool(
  "capix_list_offers",
  {
    title: "List GPU Offers",
    description: `Find live GPU offers from the Capix network that can serve a specific model.

Returns offers filtered by the model's VRAM + GPU count requirements,
sorted by price (cheapest first). Each offer includes: askId, GPU model,
VRAM, CPU, RAM, price/hr, location, reliability.

Use the askId from this list when calling capix_deploy_llm.`,
    inputSchema: {
      model_id: z.string().describe("Model ID from capix_list_models (e.g. 'jiunsong-supergemma4-31b-abliterated')"),
      region: z.string().optional().describe("Region filter: 'global', 'eu', 'us', 'asia' (default: global)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const offers = await capix.getOffers(params.model_id, params.region);

    if (offers.length === 0) {
      return { content: [{ type: "text", text: `No live GPU offers fit model '${params.model_id}' right now. Try another region or check back shortly.` }] };
    }

    const lines = offers.map((o) =>
      `askId: ${o.askId}\t${o.numGpus > 1 ? `${o.numGpus}× ` : ""}${o.gpu}\t${o.totalVramGb}GB VRAM\t${o.cpuCores} cores\t${o.ramGb}GB RAM\t$${o.roundedPricePerHr.toFixed(2)}/hr\t${o.location}\t${(o.reliability * 100).toFixed(1)}%`
    );

    return {
      content: [{ type: "text", text: `Found ${offers.length} offers:\n\n${lines.join("\n")}` }],
      structuredContent: { count: offers.length, offers } as Record<string, unknown>,
    };
  },
);

// ── Tool: Deploy LLM ───────────────────────────────────────────────────────

server.registerTool(
  "capix_deploy_llm",
  {
    title: "Deploy LLM on GPU",
    description: `Deploy an LLM model from the Capix catalog onto a rented GPU.

Returns the instance ID, API key (cpxllm_...), and the model details.
The endpoint won't be ready immediately — use capix_get_endpoint to poll
until it's live (typically 2-10 minutes for model download + boot).

The API key is the Bearer token for the OpenAI-compatible endpoint.
Billing starts immediately and stops when you call capix_destroy_llm.

Required: model_id (from capix_list_models) and askId (from capix_list_offers).
For gated models (Gemma, Llama), pass an HF token (hf_... from huggingface.co/settings/tokens).`,
    inputSchema: {
      model_id: z.string().describe("Model ID from the catalog (e.g. 'jiunsong-supergemma4-31b-abliterated')"),
      ask_id: z.number().int().describe("GPU offer ID from capix_list_offers"),
      duration_hours: z.number().int().min(1).max(720).default(1).describe("How long to keep the instance (hours)"),
      hf_token: z.string().optional().describe("Hugging Face token (hf_...) — required for gated models (Gemma, Llama)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const res = await capix.deployModel(params.model_id, params.ask_id, params.duration_hours, params.hf_token);

    if (res.ok) {
      return {
        content: [{ type: "text", text: `✓ Deploying ${res.model.label} on ${res.gpu} in ${res.location}.\nInstance #${res.instanceId}\nAPI key: ${res.apiKey}\nCost: $${res.chargedUsd.toFixed(2)} for ${params.duration_hours}h\n\nThe endpoint will be ready in 2-10 min. Use capix_get_endpoint to check status.` }],
        structuredContent: res as unknown as Record<string, unknown>,
      };
    }

    return { content: [{ type: "text", text: `Deploy failed: ${res.error || "unknown error"}` }] };
  },
);

// ── Tool: Deploy + wait for ready ──────────────────────────────────────────

server.registerTool(
  "capix_deploy_and_wait",
  {
    title: "Deploy LLM and Wait Until Ready",
    description: `Deploy an LLM and poll until the endpoint is ready.

This is a convenience tool that calls capix_deploy_llm, then polls
capix_get_endpoint every 15 seconds until the model is serving.
Returns the live endpoint URL + API key when ready.

Use this when you want to deploy a private LLM and immediately start
using it with zero manual polling. The tool will wait up to 20 minutes.

For loop engineering: deploy with duration_hours=0 (auto-renew), use the
endpoint, then call capix_destroy_llm when done.`,
    inputSchema: {
      model_id: z.string().describe("Model ID from the catalog"),
      ask_id: z.number().int().describe("GPU offer ID from capix_list_offers"),
      duration_hours: z.number().int().min(1).max(720).default(1).describe("Duration in hours"),
      hf_token: z.string().optional().describe("HF token for gated models"),
      max_wait_seconds: z.number().int().min(60).max(1200).default(600).describe("Max time to wait for ready (seconds, default 600 = 10min)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    // Step 1: deploy
    const deploy = await capix.deployModel(params.model_id, params.ask_id, params.duration_hours, params.hf_token);

    if (!deploy.ok) {
      return { content: [{ type: "text", text: `Deploy failed: ${deploy.error || "unknown error"}` }] };
    }

    // Step 2: poll until ready
    const pollInterval = 15000; // 15s
    const maxAttempts = Math.ceil(params.max_wait_seconds / 15);
    let lastStatus = "";

    for (let i = 0; i < maxAttempts; i++) {
      const status = await capix.getDeployStatus(deploy.instanceId);

      if (status.ok && status.ready && status.baseOpenAiUrl) {
        // Ready — get the API key
        const keyRes = await capix.getDeployApiKey(deploy.instanceId);
        const apiKey = keyRes.ok ? keyRes.apiKey || deploy.apiKey : deploy.apiKey;

        return {
          content: [{ type: "text", text: `✓ ${status.modelLabel} is ready!\n\nEndpoint: ${status.baseOpenAiUrl}\nAPI key: ${apiKey}\nGPU: ${status.gpu} in ${status.location}\nRate: $${status.pricePerHr.toFixed(2)}/hr\n\nUse this as your OpenAI-compatible base URL + Bearer key. Remember to call capix_destroy_llm with instance #${deploy.instanceId} when done to stop billing.` }],
          structuredContent: {
            instanceId: deploy.instanceId,
            modelLabel: status.modelLabel,
            baseUrl: status.baseOpenAiUrl,
            apiKey,
            gpu: status.gpu,
            location: status.location,
            pricePerHr: status.pricePerHr,
          } as Record<string, unknown>,
        };
      }

      lastStatus = status.ok ? status.state : "unknown";
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    return {
      content: [{ type: "text", text: `Timed out waiting for instance #${deploy.instanceId} after ${params.max_wait_seconds}s. Last status: ${lastStatus}. Use capix_get_endpoint to check manually.` }],
    };
  },
);

// ── Tool: Get endpoint status ──────────────────────────────────────────────

server.registerTool(
  "capix_get_endpoint",
  {
    title: "Get LLM Endpoint Status",
    description: `Check the status of an LLM deploy. Returns the live endpoint URL,
ready state, and GPU info. When ready=true, the baseOpenAiUrl is
the OpenAI-compatible base URL to use.

To get the API key, use capix_deploy_llm (returned once at deploy time)
or capix_reveal_hosted_key (for hosted endpoints).`,
    inputSchema: {
      instance_id: z.number().int().describe("Instance ID from capix_deploy_llm"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const status = await capix.getDeployStatus(params.instance_id);

    if (!status.ok) {
      return { content: [{ type: "text", text: "Failed to get status." }] };
    }

    const text = status.ready
      ? `✓ Ready!\nEndpoint: ${status.baseOpenAiUrl}\nModel: ${status.modelLabel}\nGPU: ${status.gpu} in ${status.location}\nRate: $${status.pricePerHr.toFixed(2)}/hr`
      : `Status: ${status.state}\nModel: ${status.modelLabel}\nGPU: ${status.gpu} in ${status.location}\nNot ready yet — model is still downloading/booting.`;

    return {
      content: [{ type: "text", text }],
      structuredContent: status as unknown as Record<string, unknown>,
    };
  },
);

// ── Tool: List deploys ─────────────────────────────────────────────────────

server.registerTool(
  "capix_list_deploys",
  {
    title: "List LLM Deploys",
    description: "List all your LLM deploys (active and destroyed) with their current status.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const res = await capix.listDeploys();

    if (!res.ok || !res.deploys?.length) {
      return { content: [{ type: "text", text: "No LLM deploys found." }] };
    }

    const lines = res.deploys.map((d: any) => {
      const live = d.live || {};
      return `Instance #${live.instanceId || "?"}\t${live.modelLabel || d.instance?.tier || "Unknown"}\t${live.ready ? "ready" : live.state || "unknown"}\t${live.gpu || ""}\t${live.location || ""}`;
    });

    return {
      content: [{ type: "text", text: `Your LLM deploys:\n\n${lines.join("\n")}` }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  },
);

// ── Tool: Destroy deploy ───────────────────────────────────────────────────

server.registerTool(
  "capix_destroy_llm",
  {
    title: "Destroy LLM Deploy",
    description: `Destroy an LLM deploy and stop billing immediately.
The endpoint and API key will stop working. The GPU instance is
terminated and you stop paying for it.

Use this when you're done with a private LLM endpoint (e.g. after
loop engineering is complete).`,
    inputSchema: {
      instance_id: z.number().int().describe("Instance ID to destroy"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const res = await capix.destroyDeploy(params.instance_id);

    if (res.ok) {
      return { content: [{ type: "text", text: `✓ Destroyed instance #${params.instance_id}. Billing stopped.` }] };
    }

    return { content: [{ type: "text", text: `Failed to destroy instance #${params.instance_id}.` }] };
  },
);

// ── Tool: Wallet balance ───────────────────────────────────────────────────

server.registerTool(
  "capix_get_balance",
  {
    title: "Get Wallet Balance",
    description: "Check your Capix wallet balance, active billing rate, and total spent.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const res = await capix.getBalance();

    if (!res.ok) {
      return { content: [{ type: "text", text: "Failed to get balance." }] };
    }

    const text = `Balance: $${res.balance.usd.toFixed(2)}\n≈ SOL: ${res.balance.sol.toFixed(4)}\n≈ USDC: ${res.balance.usdc.toFixed(2)}\nActive instances: ${res.activeInstances}\nTotal spent: $${res.totalSpent.toFixed(2)}`;

    return {
      content: [{ type: "text", text }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  },
);

// ── Tool: Hosted endpoints ─────────────────────────────────────────────────

server.registerTool(
  "capix_list_hosted",
  {
    title: "List Hosted Endpoints",
    description: `List always-on Capix-hosted LLM endpoints that are ready to use
right now (no deploy needed). These are shared endpoints operated by
Capix — just grab the base URL and key and start using them.

Use capix_reveal_hosted_key to get the full API key for a hosted endpoint.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const endpoints = await capix.getHostedEndpoints();

    if (endpoints.length === 0) {
      return { content: [{ type: "text", text: "No hosted endpoints available right now. Deploy your own with capix_deploy_llm." }] };
    }

    const lines = endpoints.map((e) =>
      `${e.modelId}\t${e.modelLabel}\t${e.region}\t${e.isSuperGemma ? "SuperGemma" : "standard"}\t${e.baseUrl}\tkey: ${e.apiKeyMasked}`
    );

    return {
      content: [{ type: "text", text: `Hosted endpoints ready now:\n\n${lines.join("\n")}` }],
      structuredContent: { count: endpoints.length, endpoints } as Record<string, unknown>,
    };
  },
);

// ── Tool: Reveal hosted key ────────────────────────────────────────────────

server.registerTool(
  "capix_reveal_hosted_key",
  {
    title: "Reveal Hosted Endpoint API Key",
    description: "Get the full API key for a Capix-hosted endpoint. Requires a minimum balance of $1.",
    inputSchema: {
      model_id: z.string().describe("Model ID from capix_list_hosted"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    if (!capix.configured()) {
      return { content: [{ type: "text", text: "Error: CAPIX_API_KEY not set." }] };
    }

    const res = await capix.revealHostedKey(params.model_id);

    if (res.ok && res.apiKey) {
      return { content: [{ type: "text", text: `API key: ${res.apiKey}\n\nUse this as the Bearer token for ${params.model_id}.` }] };
    }

    return { content: [{ type: "text", text: `Failed: ${res.error || "insufficient balance or endpoint not healthy"}` }] };
  },
);

// ── Launch ──────────────────────────────────────────────────────────────────

async function main() {
  if (!capix.configured()) {
    console.error("Warning: CAPIX_API_KEY not set. Tools will return errors until configured.");
    console.error("Get your session token from capix.network → sign in → DevTools → Cookies → capix_session");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Capix MCP Server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
