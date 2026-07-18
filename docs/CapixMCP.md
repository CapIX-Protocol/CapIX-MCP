# Capix MCP — Feature Documentation

> **Version:** 2.1.0 · **Tools:** 59 · **License:** Apache-2.0  
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

The server exposes **59 tools** grouped into seven scopes, speaking both **stdio** (for local agent integration) and **streamable HTTP** (for remote/hosted use). Authentication is handled via OAuth PKCE (through the `@capix/auth-broker`) or a simple `CAPIX_API_KEY` environment variable.

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
| `destructiveHint` | `true` for `capix_delete`, `capix_cancel`, `capix_destroy_task_resources`, `capix_website_destroy`, `capix_website_domain_remove` |
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
  "version": "2.1.0",
  "baseUrl": "https://capix.network",
  "authenticated": true,
  "authMethod": "oauth-broker",
  "tools": 59,
  "toolsByScope": { "discovery": 9, "planning": 6, "lifecycle": 7, ... },
  "billable tools": 15,
  "resources": 4,
  "prompts": 3,
  "status": "ok"
}
```

---

## 4. Tool Categories

All 59 tools are prefixed with `capix_`. Read-only tools auto-run after authentication. Billable tools require a bound `approvalToken`.

### 4.1 Discovery — 9 tools (read-only)

Account, balance, project, catalog, and status inspection. Auto-run after authentication.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 1 | `capix_account` | read-only | Inspect the authenticated account: wallet address, balance, spending limits, active deployments/agents |
| 2 | `capix_balance` | read-only | Get the cash balance (available / held / total) for the account, optionally filtered by asset (SOL / USDC / USD-credit) |
| 3 | `capix_projects` | read-only | List projects visible to the authenticated account (paginated) |
| 4 | `capix_compute_catalog` | read-only | List the live compute capability catalog (provider / region / tier / price / availability) |
| 5 | `capix_model_catalog` | read-only | List the live model endpoint catalog (model id, context length, price per 1k tokens) |
| 6 | `capix_network_status` | read-only | Inspect network and gateway status (provider health, lanes, emergency flags) |
| 7 | `capix_deployments` | read-only | List deployments for the account/project with phase + allocation state (paginated, optional phase filter) |
| 8 | `capix_receipts` | read-only | List settled work receipts (cost records) for the account (paginated, optional since-filter) |
| 9 | `capix_attestations` | read-only | List attestation evidence records for the account (TEE / zkVM, optional kind filter) |

### 4.2 Planning — 6 tools (read-only)

Plan and quote deployments without provisioning. These tools do not move funds or mutate state.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 10 | `capix_compute_plan` | read-only | Plan a compute deployment: pick provider/region/spec for the requested workload shape (CPU, RAM, storage, GPU, VRAM) |
| 11 | `capix_compute_quote` | read-only | Get a canonical quote for a compute deployment plan (locks asset/scale/FX/fee/expiry) |
| 12 | `capix_model_plan` | read-only | Plan a model endpoint deployment for the requested model hosting shape (model id, quantization, context length, GPU type/count) |
| 13 | `capix_model_quote` | read-only | Get a canonical quote for a model endpoint plan |
| 14 | `capix_stack_validate` | read-only | Validate a multi-component stack manifest (services, dependencies, network) without provisioning |
| 15 | `capix_stack_plan` | read-only | Plan a multi-service stack: produce a deployment plan graph + aggregate quote |

### 4.3 Lifecycle — 7 tools (billable, require approval)

Deploy, start, stop, restart, delete, extend, and cancel deployments. All move funds or mutate provider state and require a bound `approvalToken`.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 16 | `capix_deploy` | billable | Deploy a resource (compute or model endpoint) from a canonical quote. Takes a ledger hold + provisions resources. |
| 17 | `capix_start` | billable | Start a stopped deployment (resumes metering) |
| 18 | `capix_stop` | billable | Stop a running deployment (halts metering, keeps allocation) |
| 19 | `capix_restart` | billable | Restart a deployment (stop + start cycle) |
| 20 | `capix_delete` | billable, destructive | Delete (terminate) a deployment permanently and release its allocation |
| 21 | `capix_extend` | billable | Extend a running deployment by additional hours against a fresh hold |
| 22 | `capix_cancel` | requires approval | Cancel an in-flight operation (best-effort; may trigger compensation) |

### 4.4 Networking — 8 tools (billable + read-only)

VPC, endpoint, port, routing, and connection management.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 23 | `capix_create_vpc` | billable | Create a VPC for a project (CIDR block, region, optional name) |
| 24 | `capix_create_endpoint` | billable | Create a public network endpoint for a deployment (port, protocol, optional hostname) |
| 25 | `capix_expose_port` | billable | Expose a port (ingress) to the public internet (protocol, optional CIDR allow-list) |
| 26 | `capix_close_port` | requires approval | Close a previously exposed port (non-billable soft mutation) |
| 27 | `capix_inspect_routes` | read-only | Inspect the routing table for a deployment |
| 28 | `capix_create_private_connection` | billable | Create a private endpoint connection between deployments |
| 29 | `capix_request_dedicated_ip` | billable | Request a dedicated (non-shared) IP for a deployment (requires a canonical quote) |
| 30 | `capix_port_forward` | billable | Set up port forwarding between a deployment port and a host port |

### 4.5 Testing — 6 tools (mixed)

Disposable environments, health checks, bounded commands, log/metric inspection, and cleanup.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 31 | `capix_create_test_env` | billable | Create a disposable test environment from a spec (CPU, RAM, TTL auto-destroy, optional quote) |
| 32 | `capix_run_health_checks` | read-only | Run health checks (liveness/readiness probes) on a deployment |
| 33 | `capix_run_bounded_command` | requires approval | Run an allow-listed, time-bounded command on a deployment node (may execute code) |
| 34 | `capix_inspect_logs` | read-only | Inspect deployment logs (optional limit, since-filter, log-level filter) |
| 35 | `capix_inspect_metrics` | read-only | Inspect deployment metrics (optional time window, metric-name filter) |
| 36 | `capix_destroy_task_resources` | requires approval, destructive | Destroy all resources scoped to a task (cleanup safety gate) |

### 4.6 Verification — 6 tools (read-only)

Attestation, proof, measurement, and receipt inspection. All read-only.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 37 | `capix_fetch_attestation` | read-only | Fetch attestation evidence for a deployment (TEE / zkVM) |
| 38 | `capix_verify_attestation` | read-only | Verify an attestation against the expected reference measurement |
| 39 | `capix_fetch_proof` | read-only | Fetch a zkVM proof artifact for a workload |
| 40 | `capix_verify_proof` | read-only | Verify a zkVM proof artifact against its public inputs |
| 41 | `capix_inspect_measurement` | read-only | Inspect the recorded measurement of a workload (used to pin expected TEE state) |
| 42 | `capix_inspect_receipt` | read-only | Inspect a settled work receipt (cost breakdown, settlement, approval status) |

### 4.7 Website — 17 tools (mixed)

Full website lifecycle: create, detect, plan, quote, deploy, preview, promote, rollback, inspect, domain management, and destroy.

| # | Tool | Scope flags | Description |
|---|---|---|---|
| 43 | `capix_website_project_string_check` | read-only | Check a repository URL for framework/dep compatibility with Capix hosting |
| 44 | `capix_website_create` | billable | Create a Capix website project from a repo (repo URL, branch, optional subpath/framework) |
| 45 | `capix_website_detect` | read-only | Detect the framework/build settings of a repo without provisioning |
| 46 | `capix_website_plan` | read-only | Plan a website deployment (build + hosting plan) |
| 47 | `capix_website_quote` | read-only | Get a canonical quote for a website deploy |
| 48 | `capix_website_deploy` | billable | Deploy a website build to production (site ID, optional branch/commit/quote) |
| 49 | `capix_website_preview` | billable | Create a preview deployment for a branch |
| 50 | `capix_website_promote` | billable | Promote a preview deployment to production |
| 51 | `capix_website_rollback` | billable | Roll a website back to its previous production deployment (or a specific target) |
| 52 | `capix_website_get` | read-only | Get a website project descriptor |
| 53 | `capix_website_deployments` | read-only | List deployments for a website (paginated) |
| 54 | `capix_website_logs` | read-only | Inspect build/runtime logs for a website (optional deployment filter) |
| 55 | `capix_website_metrics` | read-only | Inspect request/bandwidth metrics for a website (time window filter) |
| 56 | `capix_website_domain_add` | billable | Attach a custom domain to a website |
| 57 | `capix_website_domain_verify` | read-only | Verify DNS ownership for a pending custom domain |
| 58 | `capix_website_domain_remove` | billable, destructive | Detach a custom domain from a website |
| 59 | `capix_website_destroy` | billable, destructive | Destroy a website project and all its deployments |

### 4.8 Summary

| Scope | Tools | Billable | Requires approval | Read-only |
|---|---|---|---|---|
| Discovery | 9 | 0 | 0 | 9 |
| Planning | 6 | 0 | 0 | 6 |
| Lifecycle | 7 | 6 | 1 | 0 |
| Networking | 8 | 6 | 1 | 1 |
| Testing | 6 | 1 | 2 | 3 |
| Verification | 6 | 0 | 0 | 6 |
| Website | 17 | 9 | 0 | 8 |
| **Total** | **59** | **22** | **4** | **33** |

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
capix_model_catalog()
```

Returns the live model endpoint catalog with model IDs, context lengths, and pricing. Read-only — auto-runs.

### 5.3 Browse compute catalog

```
capix_compute_catalog(region: "us-east-1", gpu: true)
```

Returns GPU-capable compute entries in a specific region with provider, tier, and price. Read-only — auto-runs.

### 5.4 Plan and quote a model endpoint

```
# Step 1: Plan (read-only, auto-runs)
capix_model_plan({
  modelId: "llama-3.3-70b",
  contextLength: 131072,
  gpuCount: 2,
  region: "us-east-1"
})
→ { feasible: true, provider: "...", gpu: 2, estimatedCostHourly: { amount: "1200", asset: "USD-credit", scale: 2 } }

# Step 2: Quote (read-only, auto-runs)
capix_model_quote({
  modelId: "llama-3.3-70b",
  contextLength: 131072,
  gpuCount: 2,
  region: "us-east-1"
})
→ { quoteId: "qt_abc123", price: { amount: "1200", asset: "USD-credit", scale: 2 }, expiresAt: "2026-07-15T20:00:00Z" }
```

### 5.5 Deploy from a quote (billable)

```
# Requires a bound approvalToken obtained after the user reviewed the quote cost
capix_deploy({
  quoteId: "qt_abc123",
  workloadType: "private_inference.v1",
  region: "us-east-1",
  durationHours: 4,
  env: { MODEL_ID: "llama-3.3-70b" },
  ingress: [8080]
})
→ { deploymentId: "dep_xyz789", operationId: "op_def456", phase: "provisioning", holdId: "hold_ghi012", ... }
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

### 5.6 Inspect logs and metrics

```
# Read-only, auto-runs
capix_inspect_logs({
  deploymentId: "dep_xyz789",
  limit: 200,
  level: "error"
})
→ { lines: [...], truncated: false }

capix_inspect_metrics({
  deploymentId: "dep_xyz789",
  windowMinutes: 60
})
→ { metrics: [...] }
```

### 5.7 Stop and destroy (billable)

```
# Stop (halts metering)
capix_stop({ deploymentId: "dep_xyz789" })

# Destroy (terminate permanently)
capix_delete({ deploymentId: "dep_xyz789", reason: "session complete" })
```

### 5.8 Verify an attestation (read-only)

```
capix_fetch_attestation({ deploymentId: "dep_xyz789" })
→ { attestationId: "att_001", kind: "tee", evidence: "...", measurement: "..." }

capix_verify_attestation({
  attestationId: "att_001",
  expectedMeasurement: "sha256:abc123..."
})
→ { verified: true, verifier: "capix-gateway", verifiedAt: "2026-07-15T19:00:00Z" }
```

### 5.9 Deploy a website

```
# Step 1: Detect framework (read-only)
capix_website_detect({ repoUrl: "https://github.com/user/myapp", branch: "main" })
→ { framework: "next.js", buildCommand: "npm run build", outputDir: ".next", nodeVersion: "20" }

# Step 2: Quote (read-only)
capix_website_quote({ repoUrl: "https://github.com/user/myapp" })
→ { quoteId: "qt_web001", price: { amount: "50", asset: "USD-credit", scale: 2 }, expiresAt: "..." }

# Step 3: Create site (billable)
capix_website_create({
  repoUrl: "https://github.com/user/myapp",
  branch: "main",
  framework: "next.js"
})
→ { siteId: "site_abc", status: "building", ... }

# Step 4: Deploy (billable)
capix_website_deploy({ siteId: "site_abc", branch: "main" })
→ { siteId: "site_abc", deploymentId: "dep_web001", url: "https://myapp.capix.app", status: "ready" }

# Step 5: Preview → promote workflow
capix_website_preview({ siteId: "site_abc", branch: "feature-x" })
→ { url: "https://feature-x.myapp.capix.app" }

capix_website_promote({ siteId: "site_abc" })
→ { url: "https://myapp.capix.app", status: "ready" }
```

### 5.10 Add and verify a custom domain

```
# Add domain (billable)
capix_website_domain_add({ siteId: "site_abc", domain: "www.myapp.com" })

# Verify DNS (read-only)
capix_website_domain_verify({ siteId: "site_abc", domain: "www.myapp.com" })
→ { verified: true, records: [{ type: "CNAME", value: "site_abc.capix.app" }] }
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
