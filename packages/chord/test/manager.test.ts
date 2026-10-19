import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { isChordError } from "../src/errors.ts";
import { createHost } from "../src/host.ts";
import { createHostManager, forkDriver, processLock } from "../src/manager.ts";
import { nodeLoader } from "../src/loader.ts";

const entry = fileURLToPath(new URL("./fixtures/managed-child.ts", import.meta.url));
const driver = (mode = "normal", lock?: string) =>
	forkDriver({ entry, env: { TEST_CHILD_MODE: mode }, init: { hello: "child" }, lock });

it("keeps the captured facet definition when its setup getter changes the module export", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-loader-"));
	try {
		const file = join(directory, "facet.mjs");
		await writeFile(
			file,
			'const next = {setup() {return "next";}}; let definition = {get setup() {definition = next; return () => "initial";}}; export {definition as default};\n',
		);
		const [facet] = await nodeLoader([file]);
		const instance = createHost({ self: null });
		try {
			let result: unknown;
			await instance.install({
				name: facet.name,
				setup(api) {
					result = facet.setup(api);
				},
			});
			assert.equal(result, "initial");
		} finally {
			await instance.close();
		}
	} finally {
		await rm(directory, { recursive: true });
	}
});

describe("managed processes", () => {
	it("holds a kernel lock until release and admits a new holder afterward", async () => {
		const name = randomUUID(),
			release = await processLock(name);
		try {
			await assert.rejects(processLock(name), (error) => isChordError(error) && error.reason === "locked");
		} finally {
			await release();
		}
		await (await processLock(name))();
	});
	it("serializes starts and replacement, forwards init, and stops gracefully", async () => {
		const messages: unknown[] = [];
		const manager = createHostManager({
			driver: forkDriver({ entry, init: { hello: "world" }, onMessage: (message) => messages.push(message) }),
		});
		try {
			const [first, second] = await Promise.all([manager.start(), manager.start()]);
			assert.equal(first, second);
			assert.equal(manager.status, "running");
			assert.equal(manager.liveness.booting, false);
			assert(messages.some((message) => JSON.stringify(message) === '{"fixture":{"hello":"world"}}'));
			const next = await manager.replace();
			assert.notEqual(next.pid, first.pid);
			assert.deepEqual(await first.exited, { code: 0, signal: null });
			await manager.stop();
			assert.deepEqual(await next.exited, { code: 0, signal: null });
			assert.equal(manager.status, "stopped");
		} finally {
			await manager.stop();
		}
	});
	it("enforces child-owned locks across managers", async () => {
		const name = randomUUID();
		const a = createHostManager({ driver: driver("normal", name) });
		const b = createHostManager({ driver: driver("normal", name) });
		try {
			await a.start();
			await assert.rejects(b.start(), (error) => isChordError(error) && error.reason === "locked");
			assert.equal(b.status, "stopped");
			await a.stop();
			await b.start();
			assert.equal(b.status, "running");
		} finally {
			await a.stop();
			await b.stop();
		}
	});
	it("kills a child that exceeds startup or shutdown deadlines", async () => {
		const silent = createHostManager({ driver: driver("silent"), readyTimeout: 100 });
		await assert.rejects(silent.start(), /not ready in time/);
		assert.equal(silent.status, "stopped");
		const stubborn = createHostManager({ driver: driver("ignore"), grace: 30 });
		try {
			const instance = await stubborn.start();
			await stubborn.stop();
			assert.deepEqual(await instance.exited, { code: null, signal: "SIGKILL" });
		} finally {
			await stubborn.stop();
		}
	});
	it("reports startup failures with their reason", async () => {
		const manager = createHostManager({ driver: driver("fatal") });
		await assert.rejects(manager.start(), (error) => isChordError(error) && error.reason === "fixture");
		assert.equal(manager.status, "stopped");
	});
	it("stops idle processes through the configured policy", async () => {
		const exits: unknown[] = [];
		const manager = createHostManager({
			driver: driver(),
			keepAlive: (liveness) => liveness.idleFor < 30,
			checkInterval: 10,
			onExit: (exit) => exits.push(exit),
		});
		try {
			const instance = await manager.start();
			await instance.exited;
			assert.equal(manager.status, "stopped");
			assert.equal(exits.length, 1);
		} finally {
			await manager.stop();
		}
	});
});
