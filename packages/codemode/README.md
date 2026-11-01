# Code Mode

Run JavaScript in a fresh QuickJS WebAssembly VM. Scripts call registered host functions and produce JSON, text, or images. They cannot access the host filesystem, network, process, module loader, or timers directly.

## Run a script

```ts
import { CodemodeSandbox } from "@axi/codemode";

const sandbox = new CodemodeSandbox({
	tools: [{ name: "add", execute: value => Number(value) + 1 }],
});
try {
	const result = await sandbox.execute("text('ready'); return await tools.add(4)");
	if (!result.ok) throw new Error(result.error.message);
	console.log(result.value, result.output[0]);
} finally {
	await sandbox.close();
}
```

```text
5 { type: 'text', text: 'ready' }
```

Tool arguments and results cross the VM boundary as JSON. Validate arguments in your host functions. Script failures return `{ ok: false, error }`; calling a closed sandbox rejects.

## Keep small values between runs

The caller owns persistence. Pass the current snapshot and apply writes only after success.

```ts
import { CodemodeSandbox } from "@axi/codemode";

const saved: Record<string, unknown> = { runs: 2 };
const sandbox = new CodemodeSandbox();
try {
	const result = await sandbox.execute('store("runs", load("runs") + 1)', { store: saved });
	if (!result.ok) throw new Error(result.error.message);
	for (const key of result.storeWrites.delete) delete saved[key];
	Object.assign(saved, result.storeWrites.set);
	console.log(saved.runs);
} finally {
	await sandbox.close();
}
```

```text
3
```

Scripts also have `ALL_TOOLS`, `console`, `image()` and `exit()`. Globals expose functions outside `tools`. Declaration helpers describe these functions to a model; they do not validate values.

## Choose an execution host

| Class | Import | Execution location |
| --- | --- | --- |
| `CodemodeSandbox` | `@axi/codemode` | One Node worker thread per run |
| `InlineCodemodeSandbox` | `@axi/codemode/portable` | Calling thread; provide a compiled WASM module |
| `RemoteCodemodeSandbox` | `@axi/codemode/portable` | Remote executor; tools stay in the caller |

The [Cloudflare example](examples/cloudflare/README.md) runs the VM in a separate Worker. The `/cloudflare` entry supplies a deployable Durable Object and a compiled QuickJS module.

`execute()` has a five-minute default deadline. `Infinity` disables it. Cancellation settles the caller's result and requests shutdown. A worker may still be exiting; use `acquireWorker()` and `onWorkerStarted(exited)` to track actual capacity. Inline computation blocks its thread until it yields or exhausts its interrupt budget.

## Replay a recorded execution

```ts
import { CodemodeSandbox, type CodemodeRun } from "@axi/codemode";

const sandbox = new CodemodeSandbox();
try {
	let run: CodemodeRun;
	run = sandbox.start("return [Date.now(), await tools.read()]", {
		startedAt: 1000,
		seed: 7,
		tools: [{ name: "read" }],
		onCall(call) {
			queueMicrotask(() => run.deliver(1, 1010, call.id, { ok: true, value: "saved" }));
		},
	});
	const result = await run.result;
	if (!result.ok) throw new Error(result.error.message);
	console.log(JSON.stringify(result.value));
} finally {
	await sandbox.close();
}
```

```text
[1000,"saved"]
```

`start()` fixes time, randomness, timezone and result order. Store the `onStarted` fingerprint with a recording and reject incompatible fingerprints before replay. The application persists calls and decides how to recover external actions.

See the [specification](docs/spec.md) for the full contract, limits, source directives and declaration helpers.

[API reference](docs/api.md)
