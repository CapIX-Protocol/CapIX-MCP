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

Capix MCP exposes **59 tools** grouped into seven scopes. The server speaks stdio (for local agent integration) and streamable HTTP (for remote/hosted use). Authentication is handled via OAuth PKCE (through the `@capix/auth-broker`) or a simple `CAPIX_API_KEY` environment variable.

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

## Tools (59)

All tools are prefixed with `capix_`. Read-only tools auto-run after authentication. Billable tools require a bound `approvalToken`.

### Discovery (9) — read-only

| Tool | Description |
|---|---|
| `capix_account` | Inspect the authenticated account: wallet, balance, limits, active deployments/agents |
| `capix_balance` | Get the cash balance (available / held / total) for the account |
| `capix_projects` | List projects visible to the authenticated account |
| `capix_compute_catalog` | List the live compute capability catalog (provider / region / tier / price) |
| `capix_model_catalog` | List the live model endpoint catalog (model id, context length, price) |
| `capix_network_status` | Inspect network and gateway status (provider health, lanes, emergency flags) |
| `capix_deployments` | List deployments with phase + allocation state |
| `capix_receipts` | List work receipts for the account |
| `capix_attestations` | List attestation records for the account |

### Planning (6) — read-only

| Tool | Description |
|---|---|
| `capix_compute_plan` | Plan a compute deployment (matching models to offers) |
| `capix_compute_quote` | Get a canonical quote for a compute deployment |
| `capix_model_plan` | Plan a model endpoint deployment |
| `capix_model_quote` | Get a canonical quote for a model endpoint plan |
| `capix_stack_validate` | Validate a multi-component stack definition |
| `capix_stack_plan` | Plan a multi-component stack deployment |

### Lifecycle (7) — billable, requires approval

| Tool | Description |
|---|---|
| `capix_deploy` | Deploy a resource (compute or model endpoint) from a quote |
| `capix_start` | Start a stopped deployment |
| `capix_stop` | Stop a running deployment |
| `capix_restart` | Restart a deployment (stop + start cycle) |
| `capix_delete` | Delete a deployment permanently |
| `capix_extend` | Extend a deployment's lifetime |
| `capix_cancel` | Cancel an in-progress operation |

### Networking (8) — billable, requires approval

| Tool | Description |
|---|---|
| `capix_create_vpc` | Create a VPC for a project |
| `capix_create_endpoint` | Create a network endpoint for a deployment |
| `capix_expose_port` | Expose a port on a deployment |
| `capix_close_port` | Close a previously exposed port |
| `capix_inspect_routes` | Inspect the routing table for a deployment |
| `capix_create_private_connection` | Create a private connection between deployments |
| `capix_request_dedicated_ip` | Request a dedicated IP for a deployment |
| `capix_port_forward` | Set up port forwarding for a deployment |

### Testing (6) — mixed

| Tool | Description |
|---|---|
| `capix_create_test_env` | Create an isolated test environment |
| `capix_run_health_checks` | Run health checks against a deployment |
| `capix_run_bounded_command` | Run a bounded shell command inside a deployment |
| `capix_inspect_logs` | Inspect deployment logs |
| `capix_inspect_metrics` | Inspect deployment metrics |
| `capix_destroy_task_resources` | Destroy resources created by a specific task |

### Verification (6) — read-only

| Tool | Description |
|---|---|
| `capix_fetch_attestation` | Fetch an attestation record |
| `capix_verify_attestation` | Verify an attestation against its expected measurements |
| `capix_fetch_proof` | Fetch a zkVM proof artifact for a workload |
| `capix_verify_proof` | Verify a zkVM proof artifact against its public inputs |
| `capix_inspect_measurement` | Inspect the measurement of a workload |
| `capix_inspect_receipt` | Inspect a work receipt in detail |

### Website (17)

| Tool | Description |
|---|---|
| `capix_website_project_string_check` | Check a website project string for validity |
| `capix_website_create` | Create a new website project |
| `capix_website_detect` | Auto-detect website framework from a repository |
| `capix_website_plan` | Plan a website deployment (build + hosting plan) |
| `capix_website_quote` | Get a canonical quote for a website deploy |
| `capix_website_deploy` | Deploy a website (build + host) |
| `capix_website_preview` | Create a preview deployment |
| `capix_website_promote` | Promote a preview to production |
| `capix_website_rollback` | Rollback a website to a previous deployment |
| `capix_website_get` | Get a website project descriptor |
| `capix_website_deployments` | List deployments for a website |
| `capix_website_logs` | Inspect build/runtime logs for a website |
| `capix_website_metrics` | Inspect request/bandwidth metrics for a website |
| `capix_website_domain_add` | Add a custom domain to a website |
| `capix_website_domain_verify` | Verify DNS ownership for a pending custom domain |
| `capix_website_domain_remove` | Remove a custom domain from a website |
| `capix_website_destroy` | Destroy a website and all its resources |

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
