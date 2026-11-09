# Axi architecture

Axi is a toolkit for agent applications. An application chooses storage, models,
extensions, execution environments, and a user interface. The packages provide
those parts without installing an application or selecting its policies.

## Package ownership

The dependency column lists other Axi packages required by each package's
manifest. Subpath imports keep platform adapters separate from portable code.

| Package | Owns | Axi dependencies |
| --- | --- | --- |
| `@axi/telemetry` | Trace contracts, metrics, and recording | None |
| `@axi/objects` | Typed object hosts, references, JSON revisions, resources, communication, and shared Store | Telemetry |
| `@axi/ai` | Model registration, authentication contracts, request encoding, and response streams | Telemetry |
| `@axi/codemode` | Script VMs, host calls, execution limits, and deterministic delivery | None |
| `@axi/durable` | Session records, documents, transactions, tasks, agent runs, and storage drivers | AI, Objects, Code Mode, Telemetry |
| `@axi/env` | Native filesystem, process, terminal, and SSH adapters | Durable, Objects |
| `@axi/mcp` | MCP connections, transports, and OAuth | None |
| `@axi/tui` | Terminal input, components, layout, and rendering | None |

Durable uses Objects for JSON revisions, watches, contexts, output, and SQLite
contracts. Its shared Store adapter also uses the Objects Store. Using Durable
does not require the application to start an Objects host or worker process.

MCP and Code Mode remain separate. The application supplies MCP tools to its
registry and installs Code Mode when scripts need to call tools. The TUI observes
application state. It does not own tasks or their persistence.

See the [package index](api.md) for supported imports and individual specifications.

## Follow one agent run

1. The application opens storage and passes models and a registry to `Harness.open()`.
2. A conversation accepts input. Durable records its submission and schedules work.
3. The scheduler selects a task definition and runs its current checkpoint phase.
4. The phase calls the model or a tool outside a Session mutation callback.
5. A Session commit prepares records and document changes. Storage settles the write before the Session publishes the stored revision.
6. Conversation views and watches deliver changes to the application's interface.

| Question | Source owner | Tests to read first |
| --- | --- | --- |
| When does a stored change become visible? | [Session](../packages/durable/src/session/session.ts) | [Grouped commits](../packages/durable/test/grouped-commits.test.ts), [publications](../packages/durable/test/session-publications.test.ts) |
| Which phase runs after reopening? | [Scheduler](../packages/durable/src/harness/scheduler.ts) | [Recovery boundaries](../packages/durable/test/scheduler-recovery-boundaries.test.ts), [process recovery](../packages/durable/test/process-recovery.test.ts) |
| How are models, tools, and conversations connected? | [Harness](../packages/durable/src/harness/harness.ts) | [Harness state](../packages/durable/test/harness-state.test.ts), [tool hook boundaries](../packages/durable/test/tool-hook-boundaries.test.ts) |
| How does a JSON change reach another copy? | [Delta tracker](../packages/objects/src/delta/tracker.ts) | [Delta model](../packages/objects/test/delta-model.test.ts), [array lifecycle](../packages/objects/test/delta-array-lifecycle.test.ts) |
| What happens during a code reload? | [Object host](../packages/objects/src/host/host.ts) | [Reload draining](../packages/objects/test/reload-draining.test.ts), [activation recovery](../packages/objects/test/activation-recovery.test.ts) |

## Visibility and crash recovery

Session separates preparing a change from adopting it. This lets failed writes
leave the previously published stored revision intact. Independent commits can
share a storage call while retaining their own sequences and outcomes. Ordered
storage receipts do not themselves publish Session state.

There is an explicit exception to immediate persistence. Eligible document
changes can use deferred commits. Memory observers see those changes before
storage receives them. A later flush persists the held changes. A crash before
that flush can lose them. Do not describe all visible state as already durable.

On reopening, the scheduler reads saved task records and checks the available
definitions. Recovery can leave work blocked by a missing definition or failed
migration. The application calls `resume()` after setup to start scheduling.
Opening a read-only Harness does not recover or run tasks.

A task checkpoint and a remote effect cannot share one database transaction.
A process can die after a tool succeeds but before its result is saved. Replay
policy, stable request keys, and the tool's own idempotency determine whether
retrying that effect is safe. Durable does not promise exactly-once external
effects.

Memory storage has no persistence across process loss. File and database
backends have their own durability limits. In particular, JSONL's `fsync` option
does not guarantee that every acknowledged final main-file marker survives host
failure. Read the [storage contract](../packages/durable/docs/spec.md#storage-contract)
before choosing a backend.

## Revisions, references, and reload

A delta draft is private until preparation and adoption. JSON must be a tree of
supported values with dense arrays. This keeps replay and serialization defined.
The tracker copies assigned containers and retains unchanged published values.
Operations reject dangerous property paths. Edits involving those keys use an
ancestor replacement instead. The [delta guide](../packages/objects/docs/delta.md)
describes draft ownership and stream recovery.

An Objects Host owns object instances and their lifetimes. A Facet groups
declarations. A Reference retains access to an object and reports its readiness.
Activation waits for required references and registry values. Waiting, failure,
retained state, and admitted calls have separate rules.

Reload stages declarations before publishing an accepted update. Failed plugins
can keep their previous code. Affected objects restart while retaining their
documents and tables. Existing calls can drain through the outgoing attempt.
New calls wait for the replacement. Retained snapshots can remain readable
during that transition, so readiness is not the same as snapshot availability.
See the [reload contract](../packages/objects/docs/spec.md#reload).

Durable's extension registry holds task definitions, tools, hooks, and prompt
sections. It is separate from an Objects Host's Facets and file-loading adapters.
Replacing a task definition does not replace already committed task records.
The scheduler handles version compatibility at the next phase boundary.

## Change the owner of the behavior

Start with the owning package's specification and its closest existing test.
For a storage driver, run the shared storage conformance cases. For a provider,
assert the encoded request and decoded stream through its adapter. For task or
reload changes, test both success and interrupted recovery.

Keep platform setup in adapters and persistence decisions in Session and storage.
Add a helper when it makes an ownership rule clearer or serves several callers.
A large file alone is not a reason to add another layer. Use the
[contribution guide](contributing.md) for comments and change scope, and the
[testing guide](testing.md) for focused and complete verification commands.
