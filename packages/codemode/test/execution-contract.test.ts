import { expect, test } from "vitest";
import {
	CodemodeSandbox,
	InlineCodemodeSandbox,
	RemoteCodemodeSandbox,
	loadQuickJSWasm,
	serveCodemodeRemote,
	type CodemodeHostCall,
} from "../src/index.ts";

const hosts = {
	worker: () => new CodemodeSandbox(),
	inline: () => new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }),
	remote: () =>
		new RemoteCodemodeSandbox({
			remote: () => ({
				execute: (request, exchange) =>
					serveCodemodeRemote(
						structuredClone(request),
						async (messages) => structuredClone(await exchange(structuredClone(messages))),
						{ wasm: loadQuickJSWasm() },
					),
			}),
		}),
};

for (const [name, create] of Object.entries(hosts)) {
	test(`${name} keeps mixed output ordered, detects image bytes and preserves writes when exit is caught`, async () => {
		const sandbox = create();
		try {
			const result = await sandbox.execute(
				`
				console.info("batch", { rows: 2 });
				text(false);
				image("data:image/jpeg;base64,iVBORw0K\\nGgo=");
				store("receipt", { accepted: true });
				store("previous", undefined);
				try { exit(); } catch {}
				text("too late");
				return "too late";
			`,
				{ store: { previous: 1 } },
			);
			expect(result).toEqual({
				ok: true,
				value: undefined,
				output: [
					{ type: "text", text: 'batch {"rows":2}', console: true },
					{ type: "text", text: "false" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				calls: [],
				storeWrites: { set: { receipt: { accepted: true } }, delete: ["previous"] },
			});
		} finally {
			await sandbox.close();
		}
	});

	test(`${name} orders replayed answers by sequence and keeps time monotonic after a rejected serialization`, async () => {
		const sandbox = create();
		const calls: CodemodeHostCall[] = [];
		const ready = Promise.withResolvers<void>();
		try {
			const run = sandbox.start(
				`
				const initial = [Date.now(), performance.now(), Math.random(), Math.random(), typeof WeakRef];
				const answers = [];
				await Promise.all([1, 2].map(n => tools.lookup(n).then(value => answers.push(value))));
				return { initial, answers, clock: [Date.now(), performance.now()] };
			`,
				{
					startedAt: 2000,
					seed: 0,
					tools: [{ name: "lookup" }],
					onCall(call) {
						calls.push(call);
						if (calls.length === 2) ready.resolve();
					},
				},
			);
			await ready.promise;
			expect(calls.map(({ id, target, name, args }) => ({ id, target, name, args }))).toEqual([
				{ id: 1, target: "tool", name: "lookup", args: 1 },
				{ id: 2, target: "tool", name: "lookup", args: 2 },
			]);
			expect(() => run.deliver(2, 3000, 1, { ok: true, value: 1n })).toThrow();
			run.deliver(2, 3000, 1, { ok: true, value: "first" });
			run.deliver(1, 5000, 2, { ok: true, value: "second" });
			expect(await run.result).toMatchObject({
				ok: true,
				value: {
					initial: [2000, 0, 0.6711372530266764, 0.7258461452833667, "undefined"],
					answers: ["second", "first"],
					clock: [5000, 3000],
				},
				calls: [
					{ name: "lookup", status: "ok" },
					{ name: "lookup", status: "ok" },
				],
				during: { seq: 2, issued: 2 },
			});
		} finally {
			await sandbox.close();
		}
	});

	test(`${name} rejects invalid images and oversized writes without damaging valid state`, async () => {
		const sandbox = create();
		try {
			expect(
				await sandbox.execute(`
				store("kept", [8]);
				const errors = [];
				for (const action of [
					() => image("data:image/png;base64,AAAA!"),
					() => image("https://example.invalid/image.png"),
					() => store("kept", "a".repeat(270000)),
				]) { try { action(); } catch (error) { errors.push(error.name); } }
				const copy = load("kept"); copy.push(9);
				return [errors, load("kept")];
			`),
			).toEqual({
				ok: true,
				value: [["TypeError", "TypeError", "RangeError"], [8]],
				output: [],
				calls: [],
				storeWrites: { set: { kept: [8] }, delete: [] },
			});
		} finally {
			await sandbox.close();
		}
	});
}

test("a worker reservation is released on exit and survives admission and startup failures", async () => {
	let reserved = 0;
	let exited: Promise<void> | undefined;
	const sandbox = new CodemodeSandbox({
		acquireWorker() {
			reserved++;
			return () => {
				reserved--;
			};
		},
		onWorkerStarted(value) {
			exited = value;
		},
	});
	try {
		expect(await sandbox.execute("return 19;")).toMatchObject({ ok: true, value: 19 });
		if (!exited) throw new Error("Worker exit was not reported");
		await exited;
		expect(reserved).toBe(0);
	} finally {
		await sandbox.close();
	}
	const unavailable = new CodemodeSandbox({
		acquireWorker() {
			throw new Error("capacity unavailable");
		},
	});
	try {
		expect(await unavailable.execute("return 19;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: "capacity unavailable" },
		});
	} finally {
		await unavailable.close();
	}
	const broken = new CodemodeSandbox({
		workerUrl: new URL("https://example.invalid/worker.js"),
		acquireWorker() {
			reserved++;
			return () => {
				reserved--;
			};
		},
	});
	try {
		expect(await broken.execute("return 19;")).toMatchObject({
			ok: false,
			error: { kind: "sandbox", message: expect.stringContaining("Failed to start worker:") },
		});
		expect(reserved).toBe(0);
	} finally {
		await broken.close();
	}
});
