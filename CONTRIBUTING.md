# Contributing to Capix MCP

Thank you for your interest in contributing to Capix MCP! This guide covers how to build, test, and contribute to the project.

## Prerequisites

- **Node.js** >= 18
- **TypeScript** 5.7+ (installed as a dev dependency)
- A Capix account (sign up at [capix.network](https://capix.network)) for integration testing

## Getting started

```bash
# Clone the repository
git clone https://github.com/CapIX-Protocol/CapIX-MCP.git
cd CapIX-MCP

# Install dependencies
npm install

# Build the project
npm run build

# Run the server locally
npm start

# Or run in development mode (auto-restart on file changes)
npm run dev
```

## Project structure

```
capix-mcp/
├── bin/
│   └── capix-mcp.js          # CLI entry point (imports dist/index.js)
├── src/
│   ├── index.ts              # CLI argument parsing + command dispatch
│   ├── server.ts             # McpServer assembly + transport wiring
│   ├── client.ts             # Capix API client + auth providers
│   ├── tools.ts              # All 59 tool definitions (Zod schemas + handlers)
│   ├── types.ts              # Shared types (branded IDs, money, errors)
│   ├── resources.ts          # MCP resources (capix:// URIs)
│   └── prompts.ts            # MCP guided prompts
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Build

```bash
npm run build          # Compile TypeScript to dist/
```

### Type-check

```bash
npm run typecheck      # tsc --noEmit (no output = success)
```

### Local testing

```bash
# Authenticate
npm start -- login

# Run the doctor to verify auth + tool inventory
npm start -- doctor

# Start the server on stdio
npm start

# Start with HTTP transport
npm start -- server --http 8080 --token my-secret
```

### Diagnosing issues

```bash
npm start -- doctor     # Auth status, base URL, tool inventory
npm start -- --health   # JSON health report
```

## Code style

### TypeScript conventions

- **Strict mode** is enabled (`"strict": true` in tsconfig.json). All code must pass type-checking.
- **ESM modules**: the project uses `"type": "module"` in package.json. Use `.js` extensions in imports (e.g., `import { X } from "./foo.js"`).
- **No `any`**: prefer `unknown` + type narrowing over `any`. Use Zod schemas for runtime validation of external input.
- **Branded types**: IDs (`DeploymentId`, `QuoteId`, etc.) are branded string types. Never construct them with raw string casts — use the factory functions or Zod schemas.

### Tool definitions

Every tool is defined with `defineTool()`:

```typescript
defineTool({
  name: "capix_example",
  description: "Short description. Read-only | Billable; requires approval.",
  scope: "discovery",
  ...READ_ONLY,           // or BILLABLE, APPROVAL_ONLY
  inputShape: {
    // Zod raw shape — validated by the MCP SDK before dispatch
  },
  outputShape: {
    // Optional Zod raw shape for structured output validation
  },
  handler: async (args, { client, ctx }) => {
    // Thin: translate Zod-validated args → client call → return upstream JSON
    return client.get("/api/v1/example", { id: args.id });
  },
})
```

Key rules for tool handlers:

1. **Handlers are thin** — they translate arguments into client calls and return the upstream JSON. No business logic in the handler.
2. **Billable tools** must use `callBillable()` which enforces the `approvalToken` gate.
3. **Read-only tools** use `...READ_ONLY` and auto-run after authentication.
4. **Errors** — let `CapixApiError` propagate. The server wrapper catches it and surfaces it as a structured MCP error.

### Commits

- Use clear, descriptive commit messages.
- Reference issues in the format `Fixes #123` or `Closes #456`.

## Adding a new tool

1. Add the tool definition in `src/tools.ts` using `defineTool()`.
2. Place it in the appropriate scope array (`discoveryTools`, `lifecycleTools`, etc.).
3. Update the tool count comment at the top of `tools.ts`.
4. Update the README tool table.
5. Run `npm run typecheck` to verify.
6. Run `npm start -- doctor` to verify the new tool appears in the inventory.

## Pull request process

1. **Fork** the repository and create your branch from `main`.
2. **Write tests** if applicable (the project currently relies on integration testing via `doctor` and manual verification).
3. **Type-check**: `npm run typecheck` must pass with zero errors.
4. **Build**: `npm run build` must succeed.
5. **Document**: update the README tool table if you added/changed a tool.
6. **Submit** a pull request with a clear description of what changed and why.

### PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] New tools are documented in README.md
- [ ] Tool count in `tools.ts` header comment is updated
- [ ] No secrets or API keys committed

## Reporting issues

- **Bugs**: open a [GitHub issue](https://github.com/CapIX-Protocol/CapIX-MCP/issues) with:
  - `capix-mcp --version` output
  - `capix-mcp doctor` output (redact any sensitive info)
  - Steps to reproduce
  - Expected vs actual behavior
- **Security issues**: do NOT open a public issue. Email security@capix.network.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
