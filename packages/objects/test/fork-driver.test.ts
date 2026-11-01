import assert from "node:assert/strict";
import { ChildProcess, fork } from "node:child_process";
import { afterEach, it, vi } from "vitest";
import { forkDriver } from "../src/manager.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	fork: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it("signals the fallback PID during explicit termination and exit cleanup", async () => {
	const child = new ChildProcess();
	vi.mocked(fork).mockReturnValue(child);
	const signal = vi.spyOn(process, "kill").mockReturnValue(true);
	const childSignal = vi.spyOn(child, "kill").mockReturnValue(true);
	const instance = forkDriver({ entry: "unused.mjs" }).spawn();
	assert.equal(instance.pid, -1);
	instance.killTree();
	child.emit("exit", null, "SIGKILL");
	assert.deepEqual(await instance.exited, { code: null, signal: "SIGKILL" });
	assert.deepEqual(signal.mock.calls, [
		[1, "SIGKILL"],
		[1, "SIGKILL"],
	]);
	assert.equal(childSignal.mock.calls.length, 0);
});

it("falls back to the child handle when group signalling throws", () => {
	const child = new ChildProcess();
	vi.mocked(fork).mockReturnValue(child);
	const signal = vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("No process");
	});
	const childSignal = vi.spyOn(child, "kill").mockReturnValue(true);
	forkDriver({ entry: "unused.mjs" }).spawn().killTree();
	assert.deepEqual(signal.mock.calls, [[1, "SIGKILL"]]);
	assert.deepEqual(childSignal.mock.calls, [["SIGKILL"]]);
});
