# Objects

`@axi/objects` runs typed objects locally and across process links. It manages references, observable state, documents, jobs, registries and implementation reloads.

An object factory declares what the object needs. The host activates those dependencies, opens its resources and admits calls. A reference owns access to the object. Release the reference when its caller finishes.

Persistent documents, tables and jobs use a shared SQLite Store. The Store commits a transaction before the host publishes its changes. The application owns the Store and closes it after the host.

## Package imports

| Import | Provides |
| --- | --- |
| `@axi/objects` | Contracts, hosts, references, documents, jobs, tables, registries, links and runtime telemetry schema |
| `@axi/objects/context` | Explicit cancellation, values and telemetry |
| `@axi/objects/delta` | JSON drafts, prepared revisions, operations and replay |
| `@axi/objects/json` | JSON value types and utilities |
| `@axi/objects/watch` | JSON and native watch handles |
| `@axi/objects/output` | Bounded text output and paced progress |
| `@axi/objects/sqlite` | Database contracts and migrations |
| `@axi/objects/sqlite/node` | Node SQLite connections |
| `@axi/objects/sqlite/cloudflare` | Cloudflare SQLite connections |
| `@axi/objects/telemetry-sqlite` | Queued telemetry recorder and stored trace queries |
| `@axi/objects/telemetry-sqlite/node` | Node recorder setup |
| `@axi/objects/http` | Node HTTP routes, authentication and WebSockets |
| `@axi/objects/workers` | Node worker hosts and process locks |
| `@axi/objects/workers/child` | Worker entry point without the parent build helpers |
| `@axi/objects/sync` | Experimental Store replication, compressed batches and snapshot folding |
| `@axi/objects/plugins` | Plugin discovery, builds, installation, testing and rollout |
| `@axi/objects/plugins/runtime` | Evaluation of prebuilt plugin scripts |
| `@axi/objects/surfaces` | Browser and terminal bundle publication |
| `@axi/objects/web` | Browser startup, connection and live plugin updates |
| `@axi/objects/react` | Optional React hooks and host context |
| `@axi/objects/tui` | Terminal scopes and sandbox bridge runtime |
| `@axi/objects/tui/launcher` | Trusted Node launcher, credentials and machine-action prompts |
| `@axi/objects/app` | Server and worker setup, sessions, files, users and data archives |
| `@axi/objects/app/files` | Versioned file storage, folders, live listings and file-only copying without server startup or the compiler |

The Node helpers load only when imported. Plugin builds require the optional `esbuild` peer. WebSocket hosting requires the optional `ws` peer.

## Documentation

- [Tutorial](docs/tutorial.md): build a counter, change its code and retain its state.
- [Guide](docs/guide.md): choose contracts, ownership, storage and transport.
- [Specification](docs/spec.md): lifecycle, publication, failures and limits.
- [JSON revisions](docs/delta.md): draft ownership, immutable replay, operations and streaming.
- [API reference](docs/api.md): exported names and declarations.
- [HTTP](docs/http.md), [workers](docs/workers.md) and [plugins](docs/plugins.md): Node integration.
- [Clients](docs/clients.md): browser, React and terminal integration, messages and preferences.
- [App host](docs/app.md): assemble a server and workers, authenticate clients and retain their data.
- [Store sync](docs/sync.md): upload an outbox, restore another copy and compact remote history.

Facets run as trusted code. Reload replaces implementations in a running host. Durable task recovery is provided by `@axi/durable`, which can use this package's Store and registry adapters.
