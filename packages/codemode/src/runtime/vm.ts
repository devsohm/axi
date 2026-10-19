import { Intrinsics, JSException, MAX_STACK_SIZE, QuickJS, type JSValueHandle } from "quickjs-wasi";
import type { CodemodeWasmModule } from "../wasm.ts";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./protocol.ts";
export interface VmSession {
	deliver(message: HostToWorkerMessage): void;
	dispose(): void;
}
export interface StartVmOptions {
	data: VmStartData;
	wasm: CodemodeWasmModule;
	maxStackSize?: number;
	interruptBudget?: number;
	post(message: WorkerToHostMessage): void;
	shouldInterrupt(): boolean;
}
function preludeHash(): string {
	let value = 2166136261;
	for (let i = 0; i < PRELUDE_SOURCE.length; i++) value = Math.imul(value ^ PRELUDE_SOURCE.charCodeAt(i), 16777619);
	return (value >>> 0).toString(16).padStart(8, "0");
}
const PRELUDE_HASH = preludeHash();
function randomSource(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return (mixed ^ (mixed >>> 14)) >>> 0;
	};
}
function scriptException(error: JSException): string {
	const title = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${title}\n${stack}` : title });
}
type Clock = { creating: boolean; startedAt: number; now: number; seed: number };
function quietOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, buffers: number, count: number, written: number): number {
			const view = new DataView(memory.buffer);
			let length = 0;
			for (let i = 0; i < count; i++) length += view.getUint32(buffers + 8 * i + 4, true);
			view.setUint32(written, length, true);
			return 0;
		},
	};
}
function clockOutput(clock: Clock) {
	const random = randomSource(clock.seed ^ 0x9e3779b9);
	return (memory: { readonly buffer: ArrayBufferLike }) => ({
		...quietOutput(memory),
		clock_time_get(id: number, _precision: bigint, pointer: number): number {
			const ticks = clock.creating
				? id === 0
					? BigInt(clock.seed + 1) * 1000n
					: 0n
				: BigInt(Math.round(id === 0 ? clock.now : clock.now - clock.startedAt)) * 1000000n;
			new DataView(memory.buffer).setBigUint64(pointer, ticks, true);
			return 0;
		},
		random_get(pointer: number, length: number): number {
			const bytes = new Uint8Array(memory.buffer, pointer, length);
			for (let i = 0; i < length; i += 4) {
				const value = random();
				for (let k = 0; k < 4 && i + k < length; k++) bytes[i + k] = value >>> (8 * k);
			}
			return 0;
		},
	});
}
export async function startVm(options: StartVmOptions): Promise<VmSession> {
	const { data, post } = options,
		deterministic = data.deterministic;
	const stackSize = options.maxStackSize ?? MAX_STACK_SIZE;
	const clock: Clock | undefined = deterministic && {
		creating: true,
		startedAt: deterministic.startedAt,
		now: deterministic.startedAt,
		seed: deterministic.seed >>> 0,
	};
	const vm = await QuickJS.create({
		wasm: options.wasm,
		memoryLimit: data.memoryLimitBytes,
		maxStackSize: stackSize,
		interruptHandler: options.shouldInterrupt,
		...(deterministic ? { timezoneOffset: 0, intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF } : {}),
		wasi: clock ? clockOutput(clock) : quietOutput,
	});
	if (clock) clock.creating = false;
	let disposed = false,
		issued = 0,
		processing = 0,
		expected = 1;
	const queued = new Map<number, HostToWorkerMessage>();
	let api: JSValueHandle, settle: JSValueHandle, stalled: JSValueHandle;
	const native = vm._getExports();
	const crash = (error: unknown): void =>
		post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
	const drain = (): void => {
		let jobs = 0;
		while (native.qjs_is_job_pending()) {
			if (native.qjs_execute_pending_job() < 0) throw new Error("Promise job failed");
			if (++jobs % 50 === 0 && options.shouldInterrupt()) throw new Error("Execution interrupted");
		}
		vm.callFunction(stalled, api).dispose();
	};
	const apply = (message: HostToWorkerMessage): void => {
		vm.withScope(() => {
			vm.callFunction(
				settle,
				api,
				vm.newNumber(message.id),
				message.ok ? vm.true : vm.false,
				message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				message.properties === undefined ? vm.undefined : vm.newString(message.properties),
			);
		});
		drain();
	};
	const session: VmSession = {
		dispose() {
			if (!disposed) {
				disposed = true;
				vm.dispose();
			}
		},
		deliver(message) {
			if (disposed) return;
			try {
				if (!clock) {
					apply(message);
					return;
				}
				const seq = message.seq;
				if (seq === undefined || !Number.isInteger(seq) || seq < expected || queued.has(seq))
					throw new Error(`Result ${message.id} has sequence number ${seq}, expected ${expected} or later, once`);
				queued.set(seq, message);
				for (let ready = queued.get(expected); ready !== undefined; ready = queued.get(expected)) {
					queued.delete(expected);
					if (ready.now !== undefined && Number.isFinite(ready.now)) clock.now = Math.max(clock.now, ready.now);
					processing = expected;
					apply(ready);
					post({ type: "idle", seq: expected, issued });
					expected++;
				}
			} catch (error) {
				crash(error);
			}
		},
	};
	try {
		const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
			switch (kind.toString()) {
				case "call":
				case "global":
					issued++;
					post({
						type: "call",
						id: a.toNumber(),
						target: kind.toString() === "call" ? "tool" : "global",
						name: b.toString(),
						args: c === undefined || c.isUndefined ? undefined : c.toString(),
					});
					break;
				case "output":
					post({
						type: "output",
						item:
							a.toString() === "image"
								? { type: "image", data: b.toString(), mimeType: c.toString() }
								: { type: "text", text: b.toString(), ...(a.toString() === "console" ? { console: true } : {}) },
					});
					break;
				case "done": {
					const during = deterministic ? { during: { seq: processing, issued } } : {};
					if (a.toBoolean())
						post({
							type: "done",
							ok: true,
							value: b === undefined || b.isUndefined ? undefined : b.toString(),
							writes: c.toString(),
							...during,
						});
					else post({ type: "done", ok: false, error: b.toString(), ...during });
					break;
				}
			}
			return vm.undefined;
		});
		api = vm.withScope((scope) =>
			scope.escape(
				vm.callFunction(
					vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
					vm.undefined,
					bridge,
					vm.newString(JSON.stringify(data.tools)),
					vm.newString(JSON.stringify(data.globals)),
					vm.newString(JSON.stringify(data.store)),
				),
			),
		);
		settle = api.getProp("settle");
		stalled = api.getProp("stalled");
		const run = api.getProp("run");
		if (deterministic)
			post({
				type: "started",
				fingerprint: `quickjs-wasi ${vm.versions["quickjs-wasi"]}, quickjs ${vm.versions.quickjs}, prelude ${PRELUDE_HASH}, deterministic 1, stack ${stackSize}, heap ${data.memoryLimitBytes ?? "none"}, budget ${options.interruptBudget ?? "none"}`,
			});
		let script: JSValueHandle;
		try {
			script = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
		} catch (error) {
			if (!(error instanceof JSException)) throw error;
			post({ type: "done", ok: false, error: scriptException(error) });
			return session;
		}
		vm.callFunction(run, api, script).dispose();
		script.dispose();
		drain();
		if (deterministic) post({ type: "idle", seq: 0, issued });
	} catch (error) {
		crash(error);
	}
	return session;
}
