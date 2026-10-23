# Axi Env

Remote files, processes and terminals for Durable applications.

Build the client and the daemon for the current machine:

```sh
npm run build --workspace @axi/env
npm run build:daemon --workspace @axi/env
```

The daemon needs Rust to build. An installed package uses its native binary without Rust or Node on the remote machine. SSH uses the system's `ssh` program.

## Local connection

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, localDaemon, RemoteExecutionEnv } from "@axi/env";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";

const cwd = await mkdtemp(join(tmpdir(), "axi-env-example-"));
await writeFile(join(cwd, "sample.txt"), "ready");
const connection = new Connection({ command: [localDaemon()] });
const env = new RemoteExecutionEnv({ connection, id: "local", cwd });
try {
  const result = await env.readTextFile("sample.txt", BACKGROUND_CONTEXT);
  if (!result.ok) throw result.error;
  console.log(result.value);
} finally {
  try {
    await env.cleanup(BACKGROUND_CONTEXT);
  } finally {
    connection.close();
    await rm(cwd, { recursive: true, force: true });
  }
}
```

```text
ready
```

`LocalExecutionEnv` uses Durable's Node environment and adds daemon-backed file listing. `RemoteExecutionEnv` sends filesystem and process operations through the connection. Several environments can share one connection. The caller closes it.

## SSH connections

Set `host`, `knownHostsFile` and `hostKeyAlias`. Optional fields include user, port, identity file and SSH configuration file. Use `scanHostKey()` to inspect the server's keys. Compare fingerprints through a trusted channel before calling `acceptHostKey()`.

`connectSsh()` detects the remote platform and deploys the daemon immediately. `sshConnection()` does this on its first operation. Each restart verifies the daemon's content before running it. Uploads use a temporary file and become active only after their SHA-256 matches. Changed trusted host keys require an explicit `forgetHostKey()` call.

## Lifetime and cancellation

File and directory readers belong to the daemon session that opened them. A reconnect never reuses an old handle. Close readers when finished. `cleanup()` kills this environment's running commands. It does not close the shared connection.

Watchers restore coverage after a connection loss and report an overflow because changes during the gap are unknown. `openTerminal()` provides raw bytes, input, resize, foreground-job information and an exit promise. PTYs require a Unix remote system.

The protocol carries JSON fields and binary payloads over stdin and stdout. Daemon diagnostics use stderr. Process output supports retained windows, skipped-byte counts and complete-output spill files.

See the [specification](docs/spec.md) for ownership and failure contracts, the [wire protocol](docs/protocol.md) for operations and limits, and the [environment semantics](docs/semantics.md) for files, commands and cancellation.

[API reference](docs/api.md)
