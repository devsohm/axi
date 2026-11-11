import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("a caller can receive a cancelled wait after another asynchronous operation without an unhandled rejection", () => {
	const utility = new URL("../src/harness/util.ts", import.meta.url).href;
	const source = `
		import { Waiters } from ${JSON.stringify(utility)};
		const errors = [];
		process.on("unhandledRejection", error => errors.push(error.message));
		const waiters = new Waiters();
		const first = new AbortController();
		first.abort(new Error("already cancelled"));
		const rejectedBefore = waiters.add("before", { abortSignal: first.signal });
		const second = new AbortController();
		const rejectedDuring = waiters.add("during", { abortSignal: second.signal });
		second.abort(new Error("cancelled while waiting"));
		const rejectedAtClose = waiters.add("close", {});
		waiters.rejectAll(new Error("closed"));
		const completed = waiters.add("kept", {});
		waiters.resolve("kept", 42);
		await new Promise(resolve => setImmediate(resolve));
		const results = await Promise.allSettled([rejectedBefore, rejectedDuring, rejectedAtClose, completed]);
		await new Promise(resolve => setImmediate(resolve));
		console.log(JSON.stringify({
			errors,
			results: results.map(result => result.status === "fulfilled" ? result.value : result.reason.message),
			pending: waiters.keys(),
		}));
	`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
		encoding: "utf8",
		timeout: 10000,
	});
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout)).toEqual({
		errors: [],
		results: ["already cancelled", "cancelled while waiting", "closed", 42],
		pending: [],
	});
});
