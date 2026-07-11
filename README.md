# Capix MCP Server

Deploy and manage private LLM instances on the Capix GPU network from any AI coding agent that supports [Model Context Protocol](https://modelcontextprotocol.io).

## What this does

This MCP server gives AI coding agents (opencode, Capix Code, Claude Code, etc.) the ability to:

- **Browse the model catalog** — including uncensored/abliterated models (Jiunsong partnership) + community models
- **Find live GPU offers** that fit each model's VRAM requirements
- **Deploy an LLM on a GPU** and get back an OpenAI-compatible endpoint + API key
- **Deploy + wait** — deploy and poll until the endpoint is ready (2-10 min), return the live URL + key
- **List and monitor** your active deploys (status, endpoint, GPU, price)
- **Destroy deploys** to stop billing immediately
- **Check wallet balance** and active billing rate
- **Grab hosted endpoints** — always-on Capix-hosted models ready to use now

This enables the "use a private local LLM" workflow: an agent deploys an uncensored model on a private GPU, uses it for the coding session, and destroys it when done.

## Tools

| Tool | What |
|---|---|
| `capix_list_models` | Browse catalog (filter by category, uncensored, featured) |
| `capix_list_offers` | Find live GPU offers for a specific model |
| `capix_deploy_llm` | Deploy a model → get instance ID + API key |
| `capix_deploy_and_wait` | Deploy + poll until ready → return live endpoint + key |
| `capix_get_endpoint` | Check status of a deploy (endpoint URL, ready state) |
| `capix_list_deploys` | List all your LLM deploys |
| `capix_destroy_llm` | Destroy a deploy and stop billing |
| `capix_get_balance` | Wallet balance + active billing |
| `capix_list_hosted` | List always-on Capix-hosted endpoints |
| `capix_reveal_hosted_key` | Get the API key for a hosted endpoint |

## Install

```bash
npm i -g capix-mcp-server
```

Or clone + build:

```bash
git clone https://github.com/CapIX-Protocol/CapIX-MCP.git
cd CapIX-MCP
npm install
npm run build
```

## Configure

Set environment variables:

```bash
export CAPIX_BASE_URL=https://capix.network    # default
export CAPIX_API_KEY=cpx_session.eyJ...         # from capix.network
```

Or use a `cpk_` API key (from capix.network → API Keys):

```bash
export CAPIX_API_KEY=cpk_...
```

## Wire into your AI agent

### Capix Code / opencode

Add to `~/.config/capix-code/opencode.json`:

```jsonc
{
  "mcp": {
    "capix": {
      "type": "local",
      "command": ["capix-mcp-server"],
      "enabled": true
    }
  }
}
```

The agent can now deploy, manage, and destroy LLM instances autonomously.

### Claude Code

Add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "capix": {
      "command": "capix-mcp-server"
    }
  }
}
```

## Example workflow: private uncensored LLM for a coding session

The agent (with the MCP server) can do this autonomously:

1. `capix_list_models` with `uncensored_only: true` → picks Jiunsong SuperGemma4 31B
2. `capix_list_offers` for that model → finds a 24GB GPU in Europe
3. `capix_deploy_and_wait` → deploys, waits ~5 min for boot
4. Uses the endpoint as its LLM for the coding session (uncensored, private, no data leaves the GPU)
5. `capix_destroy_llm` → destroys the instance, stops billing

Total cost: ~$0.20 for 1 hour of private uncensored LLM usage.

## License

Apache-2.0. Copyright 2026 Capix.

## Links

- **Capix Protocol** — [capix.network](https://capix.network)
- **Capix IDE** — [github.com/CapIX-Protocol/CapIX-IDE](https://github.com/CapIX-Protocol/CapIX-IDE)
- **Capix Code** (CLI assistant) — [github.com/CapIX-Protocol/CapIX-Code](https://github.com/CapIX-Protocol/CapIX-Code)
- **MCP Protocol** — [modelcontextprotocol.io](https://modelcontextprotocol.io)
