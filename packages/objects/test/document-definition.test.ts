import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { defineState, int, obj, str } from "../src/index.ts";
import { Line } from "../src/documents/line.ts";
import { SealToken } from "../src/documents/fence.ts";

it("creates independent values, upgrades old state, and applies the configured checkpoint rule", () => {
	const Progress = defineState("progress", {
		schema: obj({ count: int(), text: str() }),
		version: 2,
		persist: true,
		initial: () => ({ count: 0, text: "" }),
		migrate: (old, from) => ({ count: from, text: String(old.title) }),
		checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 3,
	});
	const first = Progress.initial(context);
	first.count = 10;
	expect(Progress.initial(context)).toEqual({ count: 0, text: "" });
	expect(Progress.migrate({ title: "restored" }, 1, context)).toEqual({
		count: 1,
		text: "restored",
	});
	expect(
		[2, 3].map((n) =>
			Progress.checkpointWhen(first, [], { deltasSinceBase: n }),
		),
	).toEqual([false, true]);
});

it("hands queued operations to one holder at a time and keeps sealed work sealed", async () => {
	const line = new Line(),
		fence = new SealToken(),
		order: string[] = [];
	const release = await line.acquire();
	const second = line.acquire().then((done) => {
		order.push("second");
		return done;
	});
	const third = line.acquire().then((done) => {
		order.push("third");
		return done;
	});
	release();
	release();
	const releaseSecond = await second;
	expect(order).toEqual(["second"]);
	fence.seal();
	fence.seal();
	expect(fence.sealed).toBe(true);
	releaseSecond();
	(await third)();
	expect(order).toEqual(["second", "third"]);
});
