# Axi

Typed libraries for agent applications.

`@axi/chord` provides typed object contracts, state, resources, registries, reloads and communication between hosts. It includes memory, IPC and WebSocket transports, a Node process manager, invocation contexts, bounded output and SQLite adapters.

```sh
npm ci
npm run build
npm run check
npm run build:daemon --workspace @axi/env
npm test
```

The package exports its root, `context`, `delta`, `node`, `output`, `sqlite`, `sqlite/node`, `sqlite/cloudflare` and `package.json` entries.

`@axi/telemetry` provides explicit callback spans, typed schemas, local recording and adapter conformance cases.

`@axi/codemode` runs JavaScript in isolated QuickJS VMs through worker, inline and remote executors. It includes tool calls, bounded output, small-state changes, deterministic runs for application-owned replay, and schema declarations. Its portable entry has no Node runtime imports.

`@axi/mcp` provides an independent MCP client with stdio and Streamable HTTP transports, tools, resources, notifications, progress and cancellation. Its OAuth subpath provides discovery, PKCE, registration, refresh and callback handling. It has no Code Mode dependency.

`@axi/ai` provides the model runtime, authentication contracts, scripted responses and transcript tools. Implemented protocols include OpenAI Chat Completions and Responses, Azure Responses, legacy Codex, Anthropic Messages, Google, Vertex, Bedrock, Mistral, image generation, four classifier APIs and the serialized message transport. A Workers AI binding adapter forwards requests through an injected binding. It includes 41 provider factories, typed catalogs, seven OAuth flows, optional global compatibility APIs and catalog maintenance scripts.

`@axi/durable` provides conversations, tasks, document transactions and memory, JSONL and SQLite storage. Its Harness connects models and extensions to queued input, generation, tool execution, compaction, cancellation and recovery. Applications observe committed state through views, watches and events. Optional subpaths provide native file and shell tools, image processing, durable Code Mode and reusable storage and environment tests.

`@axi/env` connects Durable to local and SSH environments through a native daemon. It provides file operations, file listing, watches, command execution, pseudo-terminals, host-key management and verified daemon deployment. Connections restart after loss; open handles remain tied to their original connection session.

The independent TUI library is not implemented yet.

## Install and release

GitHub releases contain local package archives. See [installation](docs/install.md) and [release builds](docs/releases.md). No npm publication is required.
