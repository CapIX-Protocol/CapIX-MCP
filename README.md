# Capix MCP — infrastructure controls for AI agents

Capix MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI coding agents the ability to deploy and manage private LLM instances, GPU compute, websites, and verified workloads on the [Capix network](https://capix.network) — all through a single authenticated connection.

<!--PEnd of auto-generated overview -->

## Quick start

```bash
npm install -g @capix/mcp
capix-mcp login
```

That's it. Your AI agent can now deploy models, manage compute, and build websites on Capix.

## How it works

Capix MCP exposes **37 tools** grouped into six scopes. The server speaks stdio (for local agent integration) and streamable HTTP (for remote/hosted use). Authentication is handled via OAuth PKCE (through the `@capix/auth-broker`) or a simple `CAPIX_API_KEY` environment variable.

Every registered tool targets a route family that exists in the Capix control plane; a registry-level gate test (`src/tools/registry.test.ts`) asserts each tool's canonical path against an audited allowlist of real route families, so the tool list below is the true surface — no phantom routes.

Read-only tools auto-run after authentication. Billable tools require a bound `approvalToken` — the agent obtains this after quoting the cost upstream, so no spend happens without explicit user consent.

## Install

### Global (recommended)

```bash
npm install -g @capix/mcp
```

### From source

```bash
git clone https://github.com/CapIX-Protocol/CapIX-MCP.git
cd CapIX-MCP
npm install
npm run build
```

## Authentication

Run the login command for an interactive OAuth flow:

```bash
capix-mcp login
```

Or set environment variables directly:

| Variable | Description | Default |
|---|---|---|
| `CAPIX_BASE_URL` | Capix network URL | `https://capix.network` |
| `CAPIX_API_KEY` | Session token or API key (fallback when no OAuth) | — |
| `CAPIX_REFRESH_TOKEN` | OAuth refresh token (auto-discovery: IDE/CLI sets this) | — |
| `CAPIX_PROJECT_ID` | Default project id for unscoped reads | — |
| `CAPIX_OAUTH_CLIENT_ID` | OAuth client id | `capix-mcp` |
| `CAPIX_MCP_HTTP_PORT` | Port for the streamable HTTP transport | — |
| `CAPIX_MCP_HTTP_TOKEN` | Bearer service token guarding the HTTP transport | — |

### Auto-discovery

When run as `capix-mcp server --stdio`, the server resolves credentials in this order:

1. **`CAPIX_API_KEY`** in env — session token set by the IDE or CLI
2. **`CAPIX_REFRESH_TOKEN`** in env — the broker refreshes to obtain an access token
3. **Stored broker credentials** — OS keyring or `~/.capix/credentials.json`

If none are found, the server starts but tool calls will fail with `not_authenticated` until credentials are resolved. CapixIDE and Capix Code set `CAPIX_REFRESH_TOKEN` automatically when signed in.

### Health check

```bash
capix-mcp --health
```

Outputs a JSON status report: version, auth method, tool count, and per-scope breakdown.

## Wire into your AI agent

### CapixIDE / Capix Code

The MCP server **auto-discovers** in both CapixIDE and Capix Code when you're signed in. The IDE sets `CAPIX_REFRESH_TOKEN` in the environment before spawning the server, so no manual configuration is needed.

To verify:

```bash
capix-mcp doctor
```

### opencode

Add to `~/.config/capix-code/opencode.json`:

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

### Claude Code

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

### Other MCP-compatible agents

Any agent that supports the Model Context Protocol can connect. Start the server on stdio (the default):

```bash
capix-mcp
```

Or with streamable HTTP:

```bash
capix-mcp server --http 8080 --token <service-token>
```

## Tools (37)

All tools are prefixed with `capix_`. Read-only tools auto-run after authentication. Billable tools require a bound `approvalToken`.

### Discovery (7) — read-only

| Tool | Description |
|---|---|
| `capix_account` | Inspect the authenticated account (id, email, wallet, billing status, identities, devices) |
| `capix_balance` | Get the account ledger balances (SOL / USDC), USD valuation, and recent transactions |
| `capix_compute_catalog` | List the enabled compute capability catalog (workload types, providers, regions) |
| `capix_network_status` | Inspect service health and live feature gates |
| `capix_deployments` | List deployments with phase + allocation state (status/cursor filters) |
| `capix_receipts` | List work receipts for the account (approval-status/agent filters) |
| `capix_meme_templates` | List the meme template + vibe catalog and AI-canvas availability (free) |

### Planning (2) — read-only

| Tool | Description |
|---|---|
| `capix_compute_quote` | Get a canonical quote for a compute workload (15-minute TTL) |
| `capix_model_quote` | Get a canonical quote for a private model endpoint |

### Lifecycle (19) — billable, requires approval

| Tool | Description |
|---|---|
| `capix_deploy` | Deploy a workload from a canonical quote |
| `capix_delete` | Terminate a deployment and settle early termination |
| `capix_cancel` | Cancel an in-flight operation |
| `capix_job_submit` | Submit a durable batch job (image + command) |
| `capix_job_list` | List durable jobs |
| `capix_job_get` | Get a job by id |
| `capix_job_logs` | Fetch job log chunks with an `after` cursor |
| `capix_job_cancel` | Request cooperative cancellation of a job |
| `capix_job_rerun` | Re-enqueue a terminal job |
| `capix_training_submit` | Submit a LoRA fine-tuning run |
| `capix_training_list` | List training runs |
| `capix_training_get` | Get a training run by id |
| `capix_training_deploy` | Deploy a finished training run (returns a handoff deep-link) |
| `capix_agent_deploy` | Deploy a hosted agent runtime (openclaw / hermes / custom) |
| `capix_agent_list` | List agent deployments |
| `capix_agent_get` | Get an agent deployment by id |
| `capix_agent_destroy` | Destroy an agent deployment (refund settles) |
| `capix_meme` | Generate a meme from a topic (template captions, or AI-canvas image at 2x price when `templateId` is omitted) |
| `capix_image_gen` | Generate an image from a text prompt (fixed per-image charge) |

### Verification (1) — read-only

| Tool | Description |
|---|---|
| `capix_inspect_receipt` | Inspect a signed route receipt (placement, price, cost basis, fees, margin) |

### Website (6)

| Tool | Description |
|---|---|
| `capix_website_create` | Create a website from a source ref (clone → detect → build → preview) |
| `capix_website_list` | List websites with their latest releases |
| `capix_website_get` | Get a website (status, URLs, releases, 50-line build log tail) |
| `capix_website_promote` | Promote a built release to production |
| `capix_website_rollback` | Roll back to a previous built release |
| `capix_website_destroy` | Destroy a website (soft delete) |

### Infra-context (2) — read-only

| Tool | Description |
|---|---|
| `capix_marketplace_browse` | Browse live GPU marketplace offers (region, trust tier, capability, price) |
| `capix_model_list` | List deployable models (public catalog + owned private endpoints) |

### Removed scopes

The pre-repair registry advertised networking (8), testing (6), and attestation/zkVM (5) tools, plus website sub-tools (domains, metrics, preview, detect, quote) and planning/lifecycle stubs — all targeting route families the control plane never implemented. They were removed in the 2026-07 repair and return when the backend ships (networking roadmap N1–N5; Secured Cloud TEE/zkVM deferred). See `src/route-families.ts` for the audited allowlist of real route families.

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CAPIX_BASE_URL` | No | Capix network URL (default: `https://capix.network`) |
| `CAPIX_API_KEY` | No* | Session token / API key (fallback when no OAuth) |
| `CAPIX_REFRESH_TOKEN` | No* | OAuth refresh token for auto-discovery |
| `CAPIX_PROJECT_ID` | No | Default project id for unscoped reads |
| `CAPIX_OAUTH_CLIENT_ID` | No | OAuth client id (default: `capix-mcp`) |
| `CAPIX_MCP_HTTP_PORT` | No | Port for the streamable HTTP transport |
| `CAPIX_MCP_HTTP_TOKEN` | No | Bearer service token guarding the HTTP transport |

\* At least one of `CAPIX_API_KEY`, `CAPIX_REFRESH_TOKEN`, or stored OAuth credentials (via `capix-mcp login`) is required for authenticated tool calls.

## CLI commands

```
capix-mcp [server] [--http <port> [--token <token>]]   Run the MCP server
capix-mcp doctor                                        Diagnose auth + tool inventory
capix-mcp login [--device]                              Authenticate via OAuth PKCE
capix-mcp logout                                        Revoke tokens + clear credentials
capix-mcp --version                                     Print version and exit
capix-mcp --health                                       Run a quick health check and exit
capix-mcp --help                                        Show help
```

## Example workflow: private LLM for a coding session

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

## Auto-discovery in CapixIDE and Capix Code

When you're signed in to CapixIDE or Capix Code, the IDE automatically:

1. Spawns `capix-mcp` as a local MCP server
2. Sets `CAPIX_REFRESH_TOKEN` in the server's environment
3. The server uses the refresh token to obtain a fresh access token via the broker

No manual configuration needed. Verify with:

```bash
capix-mcp doctor
```

## API reference

Full API documentation: [https://capix.network/docs/api](https://capix.network/docs/api)

## License

Apache-2.0. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Links

- **Capix Protocol** — [capix.network](https://capix.network)
- **Capix IDE** — [github.com/CapIX-Protocol/CapIX-IDE](https://github.com/CapIX-Protocol/CapIX-IDE)
- **Capix Code** (CLI assistant) — [github.com/CapIX-Protocol/CapIX-Code](https://github.com/CapIX-Protocol/CapIX-Code)
- **MCP Protocol** — [modelcontextprotocol.io](https://modelcontextprotocol.io)
