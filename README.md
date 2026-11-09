# Axi

Typed libraries for agent applications.

Build an agent runtime with Durable, AI, tools, and a storage backend. Add MCP,
Code Mode, execution environments, or a terminal interface as the application
needs them. Objects also provides hosts and communication for applications that
need objects across processes.

Start with the [architecture overview](docs/architecture.md), then choose a
package in the [documentation index](docs/api.md). The
[testing guide](docs/testing.md) explains local checks and their limits.

`@axi/objects` provides typed object contracts, state, resources, registries, reloads and communication between hosts. It includes memory, IPC and WebSocket transports, Node worker management, invocation contexts, bounded output and SQLite adapters.

```sh
npm ci
npm run build
npm run check
npm run build:daemon --workspace @axi/env
npm test
```

The package exposes its object runtime at the root. Separate imports provide context, deltas, watches, output, SQLite, telemetry recording, HTTP, workers, plugins, app hosts and browser and terminal clients. See the [Objects package](packages/objects/README.md) for import paths.

`@axi/telemetry` provides explicit callback spans, typed schemas, local recording and adapter conformance cases.

`@axi/codemode` runs JavaScript in isolated QuickJS VMs through worker, inline and remote executors. It includes tool calls, bounded output, small-state changes, deterministic runs for application-owned replay, and schema declarations. Its portable entry has no Node runtime imports.

`@axi/mcp` provides an independent MCP client with stdio and Streamable HTTP transports, tools, resources, notifications, progress and cancellation. Its OAuth subpath provides discovery, PKCE, registration, refresh and callback handling. It has no Code Mode dependency.

`@axi/ai` provides the model runtime, authentication contracts, scripted responses and transcript tools. Implemented protocols include OpenAI Chat Completions and Responses, Azure Responses, legacy Codex, Anthropic Messages, Google, Vertex, Bedrock, Mistral, image generation, four classifier APIs and the serialized message transport. A Workers AI binding adapter forwards requests through an injected binding. It includes provider factories, typed catalogs, OAuth flows, optional global compatibility APIs and catalog maintenance scripts.

`@axi/durable` provides conversations, tasks, document transactions and memory, JSONL, SQLite and IndexedDB storage. Its Harness connects models and extensions to queued input, generation, tool execution, compaction, cancellation and recovery. Applications observe committed state through views, watches and events. Optional subpaths provide native file and shell tools, image processing, durable Code Mode and reusable storage and environment tests.

`@axi/env` connects Durable to local and SSH environments through a native daemon. It provides file operations, file listing, watches, command execution, pseudo-terminals, host-key management and verified daemon deployment. Connections restart after loss; open handles remain tied to their original connection session.

`@axi/tui` provides scrollback and fullscreen renderers, layout, overlays, mouse selection, a multiline editor, completion, Markdown, mathematical notation, images and color utilities. It is independent of Durable. Applications connect runtime subscriptions and commands to their own message and tool components. Native helpers build locally on Linux, macOS and Windows. Cross-platform runtime verification remains outstanding.

## Install and release

GitHub releases contain local package archives. See [installation](docs/install.md) and [release builds](docs/releases.md). No npm publication is required.

## Test the packages

Run `npm run verify` for builds, local tests, native checks, worker checks and installed-package verification. See [testing](docs/testing.md) for prerequisites, focused commands and coverage limits.

[Package documentation](docs/api.md) · [Contributing](docs/contributing.md)
