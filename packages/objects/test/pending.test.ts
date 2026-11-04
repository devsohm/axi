import { describe, expect, it } from "vitest";
import { PendingOps, type Op } from "../src/delta/index.ts";

describe("pending changes", () => {
	it("folds independent leaves without rewriting the received batches", () => {
		const queue = new PendingOps();
		const received: readonly Op[] = [["a", ["answer"], "A"]];
		queue.push(received);
		const first = queue.take();
		expect(first.kind === "ops" && first.ops).toBe(received);
		queue.push(received);
		queue.push([
			["s", ["tokens"], 1],
			["a", ["answer"], "B"],
		]);
		queue.push([["s", ["tokens"], 2]]);
		expect(queue.take()).toEqual({
			kind: "ops",
			ops: [
				["a", ["answer"], "AB"],
				["s", ["tokens"], 2],
			],
		});
		expect(received).toEqual([["a", ["answer"], "A"]]);
	});
	it("keeps edits on either side of a structural change in order", () => {
		const queue = new PendingOps();
		queue.push([["s", ["rows", 0], "old"]]);
		queue.push([["p", ["rows"], 0, 1, ["new"]]]);
		queue.push([["s", ["rows", 0], "last"]]);
		expect(queue.take()).toEqual({
			kind: "ops",
			ops: [
				["s", ["rows", 0], "old"],
				["p", ["rows"], 0, 1, ["new"]],
				["s", ["rows", 0], "last"],
			],
		});
		expect(queue.size).toBe(0);
	});
});
