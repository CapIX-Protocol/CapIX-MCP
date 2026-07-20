# Capix MCP — Feature Documentation

> **Version:** 2.1.1 · **Tools:** 37 · **License:** Apache-2.0  
> **Repository:** [CapIX-Protocol/CapIX-MCP](https://github.com/CapIX-Protocol/CapIX-MCP)  
> **Protocol:** [Model Context Protocol](https://modelcontextprotocol.io)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Tool Categories](#4-tool-categories)
5. [Usage](#5-usage)

---

## 1. Overview

Capix MCP is a Model Context Protocol server that gives AI coding agents the ability to deploy and manage private LLM instances, GPU compute, websites, and verified workloads on the [Capix network](https://capix.network) — all through a single authenticated connection.

### What it is

The server exposes **37 tools** grouped into six scopes, speaking both **stdio** (for local agent integration) and **streamable HTTP** (for remote/hosted use). Authentication is handled via OAuth PKCE (through the `@capix/auth-broker`) or a simple `CAPIX_API_KEY` environment variable.

Every registered tool targets a route family that exists in the Capix control plane. Each tool declares its canonical path (`routePath`), and a registry gate test asserts it against the audited allowlist in `src/route-families.ts` — phantom tools cannot be re-introduced.

### Control-plane invariants

Every tool call enforces three invariants:

1. **Read-only tools auto-run** after authentication. No user consent needed for listing, inspecting, or quoting.
2. **Billable tools require a bound `approvalToken`** — the agent obtains this after quoting the cost upstream, so no spend happens without explicit user consent. Tools without an approval token are rejected with a structured `approval_required` MCP error.
3. **Every billable action produces a work receipt** with a cost breakdown.

### Tool classification flags

Each tool carries two flags that determine its control-plane behavior:

| Flag set | `billable` | `requiresApproval` | Behavior |
|---|---|---|---|
| `READ_ONLY` | `false` | `false` | Auto-runs after auth. `readOnlyHint: true` |
| `BILLABLE` | `true` | `true` | Requires bound `approvalToken`. Moves funds or mutates provider state. |
| `APPROVAL_ONLY` | `false` | `true` | Requires `approvalToken` (mutates state but doesn't move funds). |

### MCP annotations

The server derives standard MCP tool annotations from these flags:

| Annotation | Rule |
|---|---|
| `readOnlyHint` | `true` when `!billable && !requiresApproval` |
| `destructiveHint` | `true` for `capix_delete`, `capix_cancel`, `capix_website_destroy`, `capix_agent_destroy` |
| `idempotentHint` | `true` when `!billable` or `scope === 'discovery'` |
| `openWorldHint` | `true` (all tools interact with the external Capix network) |

### Transports

| Transport | Usage |
|---|---|
| **stdio** (default) | `StdioServerTransport` — for local agent integration (CapixIDE, Capix Code, Claude Code, opencode) |
| **Streamable HTTP** | `StreamableHTTPServerTransport` — for remote/hosted use. Exposes `/mcp` (POST for requests, GET for SSE streams) and `/healthz` (GET for readiness) |

### Authentication methods

| Method | Description |
|---|---|
| **OAuth PKCE** (browser flow) | `capix-mcp login` — interactive browser flow via `@capix/auth-broker` |
| **OAuth device code** | `capix-mcp login --device` — for headless environments |
| **API key** | `CAPIX_API_KEY` env var — session token from `capix.network` |
| **Refresh token** | `CAPIX_REFRESH_TOKEN` env var — auto-discovery; IDE/CLI sets this automatically |
| **Stored broker credentials** | OS keyring or `~/.capix/credentials.json` |

---

## 2. Installation

### 2.1 Global install (recommended)

```bash
npm install -g @capix/mcp
```

Verify the installation:

```bash
capix-mcp --version
capix-mcp --health
```

Requires Node.js 18 or newer (`engines.node >= 18`). The npm package has provenance attestation enabled.

### 2.2 From source

```bash
git clone https://github.com/CapIX-Protocol/CapIX-MCP.git
cd CapIX-MCP
npm install
npm run build
```

The build output is in `dist/`. The CLI entry point is `bin/capix-mcp.js` → `dist/index.js`.

### 2.3 Authenticate

```bash
capix-mcp login
```

This runs the interactive OAuth PKCE browser flow (or `capix-mcp login --device` for headless). After login, credentials are stored in `~/.capix/credentials.json` (or the OS keyring if `@capix/auth-broker` is installed).

Alternatively, set environment variables directly:

```bash
export CAPIX_API_KEY="capix_session_token_from_capix_network"
# OR
export CAPIX_REFRESH_TOKEN="oauth_refresh_token"
```

---

## 3. Configuration

### 3.1 Environment variables

| Variable | Required | Description | Default |
|---|---|---|---|
| `CAPIX_BASE_URL` | No | Capix network URL | `https://capix.network` |
| `CAPIX_API_KEY` | No* | Session token / API key (fallback when no OAuth) | — |
| `CAPIX_REFRESH_TOKEN` | No* | OAuth refresh token (auto-discovery: IDE/CLI sets this) | — |
| `CAPIX_PROJECT_ID` | No | Default project id for unscoped reads | — |
| `CAPIX_OAUTH_CLIENT_ID` | No | OAuth client id | `capix-mcp` |
| `CAPIX_MCP_HTTP_PORT` | No | Port for the streamable HTTP transport | — |
| `CAPIX_MCP_HTTP_TOKEN` | No | Bearer service token guarding the HTTP transport | — |

\* At least one of `CAPIX_API_KEY`, `CAPIX_REFRESH_TOKEN`, or stored OAuth credentials (via `capix-mcp login`) is required for authenticated tool calls.

### 3.2 Auto-discovery

When run as `capix-mcp server --stdio`, the server resolves credentials in this order:

1. **`CAPIX_API_KEY`** in env — session token set by the IDE or CLI
2. **`CAPIX_REFRESH_TOKEN`** in env — the broker refreshes to obtain an access token
3. **Stored broker credentials** — OS keyring or `~/.capix/credentials.json`

If none are found, tool calls fail with `not_authenticated` until credentials are resolved. CapixIDE and Capix Code set `CAPIX_REFRESH_TOKEN` automatically when signed in.

### 3.3 CapixIDE / Capix Code (auto-discovery)

The MCP server **auto-discovers** in both CapixIDE and Capix Code when you're signed in:

1. The IDE/CLI spawns `capix-mcp` as a local MCP server.
2. Sets `CAPIX_REFRESH_TOKEN` in the server's environment.
3. The server uses the refresh token to obtain a fresh access token via the broker.

No manual configuration needed. Verify with:

```bash
capix-mcp doctor
```

### 3.4 VS Code / CapixIDE MCP settings

Add to your VS Code or CapixIDE MCP settings (`.mcp.json` in the project root or workspace settings):

```json
{
  "mcpServers": {
    "capix": {
      "command": "capix-mcp"
    }
  }
}
```

For CapixIDE, the server auto-discovers when signed in (see [§3.3](#33-capixide--capix-code-auto-discovery)). No config file needed.

### 3.5 opencode / Capix Code config

Add to `~/.config/capix-code/capix-code.json` (or `opencode.json`):

```jsonc
{
  "mcp": {
    "capix": {
      "type": "local",
      "command": ["capix-mcp"],
      "enabled": true
    }
  }
}
```

Capix Code also auto-registers the MCP server programmatically via its plugin's `config` hook — if you're using Capix Code, the MCP server is already wired.

### 3.6 Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "capix": {
      "command": "capix-mcp"
    }
  }
}
```

### 3.7 Streamable HTTP transport

For remote or hosted use:

```bash
capix-mcp server --http 8080 --token <service-token>
```

The server exposes:
- `POST /mcp` — JSON-RPC requests
- `GET /mcp` — SSE streams
- `GET /healthz` — readiness probe (returns version, tool count, auth status)

The `--token` (or `CAPIX_MCP_HTTP_TOKEN`) is a bearer service token that must be present on every request to the HTTP transport.

### 3.8 Other MCP-compatible agents

Any agent that supports the Model Context Protocol can connect. Start the server on stdio (the default):

```bash
capix-mcp
```

Or explicitly:

```bash
capix-mcp server --stdio
```

### 3.9 CLI commands

| Command | Description |
|---|---|
| `capix-mcp` (or `capix-mcp server`) | Run the MCP server. Defaults to stdio. Use `--http <port>` for HTTP. |
| `capix-mcp doctor` | Diagnose auth, base URL, and list the tool inventory (per-scope breakdown) |
| `capix-mcp login [--device]` | Authenticate via OAuth PKCE (browser flow) or device-code flow |
| `capix-mcp logout` | Revoke tokens and clear stored credentials |
| `capix-mcp --version` | Print version and exit |
| `capix-mcp --health` | Quick health check: auth method, tool count, per-scope breakdown, status |
| `capix-mcp --help` | Show help |

### 3.10 Health check output

```bash
capix-mcp --health
```

Outputs a JSON status report:

```json
{
  "service": "capix-mcp",
  "version": "2.1.1",
  "baseUrl": "https://capix.network",
  "authenticated": true,
  "authMethod": "oauth-broker",
  "tools": 37,
  "toolsByScope": { "discovery": 7, "planning": 2, "lifecycle": 19, "verification": 1, "website": 6, "infra-context": 2 },
  "billable tools": 13,
  "resources": 8,
  "prompts": 4,
  "status": "ok"
}
```

---

## 4. Tool Categories

All 37 tools are prefixed with `capix_`. Read-only tools auto-run after authentication. Billable tools require a bound `approvalToken`. Every tool's canonical path is gated against the audited allowlist of real control-plane route families (`src/route-families.ts`).

### 4.1 Discovery — 7 tools (read-only)

Account, balance, catalog, status, deployment, and receipt inspection. Auto-run after authentication.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 1 | `capix_account` | read-only | Inspect the authenticated account (id, email, wallet address, billing status, identities, devices) |
| 2 | `capix_balance` | read-only | Get the account ledger balances (SOL / USDC), USD valuation, and recent transactions (optional asset filter) |
| 3 | `capix_compute_catalog` | read-only | List the enabled compute capability catalog: workload types with features, configured providers/regions |
| 4 | `capix_network_status` | read-only | Inspect service health: status, version, release, live feature gates |
| 5 | `capix_deployments` | read-only | List deployments for the account/project (status filter, cursor pagination, ≤100/page) |
| 6 | `capix_receipts` | read-only | List work receipts for the account (approval-status / agent filters, cursor pagination) |
| 7 | `capix_meme_templates` | read-only | List the meme template + vibe catalog and AI-canvas availability (free) |

### 4.2 Planning — 2 tools (read-only)

Canonical quotes against `POST /api/v1/quotes` (15-minute TTL; locks price/cost/fees/margin/FX/expiry). The quote route requires an Idempotency-Key, which the client supplies — quoting moves no funds.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 8 | `capix_compute_quote` | read-only | Quote a compute workload (`workloadSpec`: type, cpu, ramMb, storageGb, optional gpu/region/duration) |
| 9 | `capix_model_quote` | read-only | Quote a private model endpoint (`private_inference.v1` + `payload.modelId`) |

### 4.3 Lifecycle — 19 tools (billable / approval / read-only)

Deployments, durable jobs, training runs, agent deploys, and the two content generators. Mutations are idempotent and require a bound `approvalToken`.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 10 | `capix_deploy` | billable | Deploy a workload from a canonical quote (`quoteId`). Takes a ledger hold; returns an operation |
| 11 | `capix_delete` | billable, destructive | Terminate a deployment and settle early termination |
| 12 | `capix_cancel` | requires approval | Cancel an in-flight operation (`POST /api/v1/operations/:id`) |
| 13 | `capix_job_submit` | billable | Submit a durable batch job (image + command; idempotent) |
| 14 | `capix_job_list` | read-only | List durable jobs |
| 15 | `capix_job_get` | read-only | Get a job by id (`GET /api/v1/jobs?id=…` — there is no `/jobs/[id]` route) |
| 16 | `capix_job_logs` | read-only | Fetch job log chunks with `after` seq cursor + `limit` (≤5000) |
| 17 | `capix_job_cancel` | requires approval | Request cooperative cancellation of a job |
| 18 | `capix_job_rerun` | billable | Re-enqueue a terminal job (idempotent) |
| 19 | `capix_training_submit` | billable | Submit a LoRA fine-tuning run (allow-listed base models; ledger hold) |
| 20 | `capix_training_list` | read-only | List training runs |
| 21 | `capix_training_get` | read-only | Get a training run by id |
| 22 | `capix_training_deploy` | requires approval | Deploy a finished run — returns a handoff deep-link, not a completed deployment |
| 23 | `capix_agent_deploy` | billable | Deploy a hosted agent runtime (openclaw / hermes / custom; minted key shown once) |
| 24 | `capix_agent_list` | read-only | List agent deployments |
| 25 | `capix_agent_get` | read-only | Get an agent deployment by id |
| 26 | `capix_agent_destroy` | billable, destructive | Destroy an agent deployment (VM teardown, key revoke, hold refund) |
| 27 | `capix_meme` | billable | Generate a meme from a topic (template captions, or AI-canvas at 2x when `templateId` omitted) |
| 28 | `capix_image_gen` | billable | Generate an image from a text prompt (fixed per-image charge) |

### 4.4 Verification — 1 tool (read-only)

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 29 | `capix_inspect_receipt` | read-only | Inspect a signed route receipt (placement decision, customer price, provider cost basis, fees, margin) |

### 4.5 Website — 6 tools (mixed)

Static-site hosting on the real `/api/v1/websites` family. Build logs surface as `logTail` inside `capix_website_get`; previews are implicit per release.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 30 | `capix_website_create` | billable | Create a website from a source ref (name + sourceRef, optional buildCommand) — clones, detects, builds |
| 31 | `capix_website_list` | read-only | List websites with their latest releases |
| 32 | `capix_website_get` | read-only | Get a website: status, URLs, releases with build step/error/log tail |
| 33 | `capix_website_promote` | billable | Promote a built release to production |
| 34 | `capix_website_rollback` | billable | Roll back to a previous built release |
| 35 | `capix_website_destroy` | billable, destructive | Destroy a website (soft delete) |

### 4.6 Infra-context — 2 tools (read-only)

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 36 | `capix_marketplace_browse` | read-only | Browse live GPU marketplace offers (gpuModel/region/trustTier/capability filters, cursor pagination) |
| 37 | `capix_model_list` | read-only | List deployable models: public catalog + owned ready private endpoints |

### 4.7 Removed scopes (2026-07 repair)

The pre-repair registry advertised **networking** (8 tools: VPC/endpoints/ports/DNS), **testing** (6 tools: disposable envs, bounded commands, log/metric inspection), and **attestation/zkVM** (5 tools) scopes, plus website sub-tools (domains, metrics, preview, detect, quote, deploy, logs) and planning/lifecycle stubs (`capix_*_plan`, `capix_stack_*`, `capix_start/stop/restart/extend`) — all targeting route families the control plane never implemented (`/api/v1/networking/*`, `/api/v1/testing/*`, `/api/v1/verification/*`, `/api/v1/planning/*`, `/api/v1/lifecycle/*`, singular `/api/v1/website/*`). They were removed from the registry and return when the backend ships (networking roadmap N1–N5; Secured Cloud TEE/zkVM deferred). `capix_start`/`capix_stop` additionally wait on client PATCH + If-Match support for `PATCH /api/v1/deployments/[id]`.

### 4.8 Summary

| Scope | Tools | Billable | Requires approval | Read-only |
|---|---|---|---|---|
| Discovery | 7 | 0 | 0 | 7 |
| Planning | 2 | 0 | 0 | 2 |
| Lifecycle | 19 | 9 | 3 | 7 |
| Verification | 1 | 0 | 0 | 1 |
| Website | 6 | 4 | 0 | 2 |
| Infra-context | 2 | 0 | 0 | 2 |
| **Total** | **37** | **13** | **3** | **21** |

---

## 5. Usage

### 5.1 Example workflow: private LLM for a coding session

```bash
# 1. Authenticate
capix-mcp login

# 2. Your AI agent can now (autonomously):
#    - Browse the model catalog
#    - Find a GPU that fits the model's VRAM requirements
#    - Deploy + wait for the endpoint to be ready
#    - Use the endpoint as its LLM for the coding session
#    - Destroy the instance when done to stop billing
```

The agent follows the Capix control-plane invariants:
1. Read-only tools auto-run after authentication
2. Billable tools require a bound `approvalToken` (obtained after quoting)
3. Every billable action produces a work receipt with a cost breakdown

### 5.2 List available models

```
capix_model_list()
```

Returns the public model catalog plus the caller's ready private endpoints with model IDs, context windows, and pricing. Read-only — auto-runs.

### 5.3 Browse the compute capability catalog

```
capix_compute_catalog()
```

Returns the enabled workload types (with features) and configured providers/regions. Public — auto-runs.

### 5.4 Quote a model endpoint

```
# Read-only, auto-runs (the quote route requires an Idempotency-Key, supplied by the client)
capix_model_quote({
  modelId: "llama-3.1-8b-instruct",
  cpu: 8,
  ramMb: 32768,
  storageGb: 100,
  gpu: 1,
  region: "eu"
})
→ { id: "qt_abc123", price: { ... }, expiresAt: "2026-07-15T20:00:00Z", state: "ACTIVE" }
```

### 5.5 Deploy from a quote (billable)

```
# Requires a bound approvalToken obtained after the user reviewed the quote cost
capix_deploy({ quoteId: "qt_abc123" })
→ { operation: { id: "op_def456", status: "PENDING", ... }, deployment: { id: "dep_xyz789", phase: "PROVISIONING", ... } }
```

Without an `approvalToken`, the tool call is rejected:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "approval_required: capix_deploy moves funds or mutates provider state and requires a bound approvalToken (§5). Re-request the tool call with an approvalToken obtained after the user reviewed the canonical cost."
  }]
}
```

### 5.6 Submit and tail a batch job

```
# Billable, idempotent
capix_job_submit({ image: "alpine:3", command: ["sh", "-c", "echo hi"] })
→ { job: { id: "job_abc", status: "queued", ... } }

# Read-only; re-poll with after = nextAfter to tail
capix_job_logs({ id: "job_abc", after: 0, limit: 1000 })
→ { job: { id: "job_abc", status: "running" }, logs: [...], nextAfter: 42 }
```

### 5.7 Terminate a deployment (billable)

```
# Terminate (settles early termination, releases the allocation)
capix_delete({ id: "dep_xyz789" })
→ { operation: { ... }, settlement: { capturedAmount: "...", refundedAmount: "..." } }
```

### 5.8 Inspect a signed route receipt (read-only)

```
capix_inspect_receipt({ receiptId: "rr_001" })
→ { id: "rr_001", data: { workloadType: "private_inference.v1", customerPrice: { ... }, fees: { ... }, margin: { ... } }, signature: "...", kmsKeyId: "..." }
```

### 5.9 Ship a website

```
# Step 1: Create + build (billable; framework is detected server-side)
capix_website_create({ name: "myapp", sourceRef: "https://github.com/user/myapp" })
→ { website: { id: "web_abc", status: "building", previewUrl: null, ... } }

# Step 2: Poll until the release is built (read-only; includes the build log tail)
capix_website_get({ id: "web_abc" })
→ { website: { status: "preview", previewUrl: "https://capix.network/sites/rel_001/", releases: [{ id: "rel_001", status: "built", logTail: [...] }] } }

# Step 3: Promote to production (billable)
capix_website_promote({ id: "web_abc", releaseId: "rel_001" })
→ { ok: true, productionUrl: "https://capix.network/sites/myapp/", releaseId: "rel_001" }
```

### 5.10 Deploy an agent runtime

```
# Billable, idempotent; the minted API key is shown ONCE (replays return it redacted)
capix_agent_deploy({ runtime: "openclaw", tier: "micro", name: "my-agent", durationHours: 4 })
→ { deployment: { id: "agd_001", status: "provisioning", ... }, mintedKey: { apiKey: "cpxk_...", ... }, gatewayToken: "..." }

capix_agent_get({ id: "agd_001" })
→ { deployment: { status: "ready", agentUrl: "https://..." }, logsTail: [...] }
```

### 5.11 Error handling

Tool errors are surfaced as structured MCP error results with the Capix problem+json format:

```json
{
  "ok": false,
  "error": {
    "capixCode": "insufficient_balance",
    "message": "Account balance is insufficient for this deployment",
    "status": 402
  },
  "tool": "capix_deploy"
}
```

Errors thrown by the Capix API client (`CapixApiError`) include the full RFC 7807 `ProblemDetail` body (type, title, status, detail, capixCode, retryClass, operationId, supportId, traceId). Unexpected errors are surfaced as `tool_internal_error`.

### 5.12 Resources and prompts

The server also registers:

- **Resources** (`capix://` URI scheme) — machine-readable capability and status documents
- **Prompts** — guided workflow templates for common deployment scenarios

---

*Copyright 2026 Capix. Licensed under the Apache License, Version 2.0.*
