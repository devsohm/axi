import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT, type TelemetrySpan } from "../src/index.ts";
import { createTelemetryAdapterConformance } from "../src/testing/index.ts";

describe("telemetry capture", () => {
	it("rejects an adapter that loses the names of failed operations", async () => {
		const cases = createTelemetryAdapterConformance(async () => {
			const context = new InMemoryTelemetryContext();
			return {
				context,
				getSpans: async () => context.getSpans().map((span) => ({ ...span, name: "wrong" })),
				async [Symbol.asyncDispose]() {},
			};
		});
		const check = cases.find((row) => row.name === "preserves synchronous and asynchronous rejection values");
		if (!check) throw new Error("Missing rejection case");
		await expect(check.run()).rejects.toThrow("Expected recorded span sync-error");
	});
	it("retains recorder capabilities through a completed span and its inactive descendants", () => {
		const module = new URL("../src/index.ts", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				"--input-type=module",
				"--eval",
				`
			import assert from "node:assert/strict";
			import { setImmediate } from "node:timers/promises";
			import { InMemoryTelemetryContext } from ${JSON.stringify(module)};
			async function hold() {
				const context = new InMemoryTelemetryContext();
				let span;
				await context.startSpan({name: "completed"}, current => { span = current; });
				return { root: new WeakRef(context), span };
			}
			const {root, span} = await hold();
			for (let i = 0; i < 16; i++) { await setImmediate(); globalThis.gc(); }
			assert.equal(root.deref(), span.metrics);
			assert.notEqual(root.deref(), undefined);
			assert.equal(span.propagation, span.metrics);
			assert.equal(await span.startSpan({name: "late"}, child => {
				assert.equal(child.metrics, span.metrics);
				assert.equal(child.propagation, span.propagation);
				return 42;
			}), 42);
		`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(child.status, child.stderr).toBe(0);
	});
	it("captures independent children and returns detached array attributes", async () => {
		const context = new InMemoryTelemetryContext();
		const tags = ["start"];
		await context.startSpan({ name: "request", attributes: { tags } }, async (parent) => {
			tags.push("changed");
			await parent.startSpan({ name: "parse" }, (child) => child.addEvent("complete", { count: 2 }));
		});
		const first = context.getSpans();
		expect(first.map(({ context, parentContext, links, ...span }) => span)).toEqual([
			{
				id: 1,
				parentId: null,
				name: "request",
				attributes: { tags: ["start"] },
				events: [],
				status: { status: "ok" },
				settled: true,
				endSequence: 2,
			},
			{
				id: 2,
				parentId: 1,
				name: "parse",
				attributes: {},
				events: [{ name: "complete", attributes: { count: 2 } }],
				status: { status: "ok" },
				settled: true,
				endSequence: 1,
			},
		]);
		expect(first[0].parentContext).toBeNull();
		expect(first[1].parentContext).toEqual(first[0].context);
		expect(first[1].context).not.toEqual(first[0].context);
		expect(first.map((span) => span.links)).toEqual([[], []]);
		const values = first[0].attributes.tags;
		if (Array.isArray(values)) values.push("snapshot edit");
		expect(context.getSpans()[0].attributes).toEqual({ tags: ["start"] });
	});
	it("keeps a completed parent's late child inert while still executing its callback", async () => {
		const context = new InMemoryTelemetryContext();
		let parent: TelemetrySpan | undefined;
		await context.startSpan({ name: "parent" }, (span) => {
			parent = span;
		});
		expect(await parent?.startSpan({ name: "late" }, () => 42)).toBe(42);
		expect(context.getSpans().map((span) => span.name)).toEqual(["parent"]);
	});
	it("surfaces rejection inspection failures when recording and preserves the original when disabled", async () => {
		const error = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("cannot inspect");
				},
			},
		);
		for (const context of [new InMemoryTelemetryContext(), NOOP_TELEMETRY_CONTEXT]) {
			let actual: unknown;
			await context
				.startSpan({ name: "failure" }, () => Promise.reject(error))
				.catch((value) => {
					actual = value;
				});
			if (context === NOOP_TELEMETRY_CONTEXT) expect(actual).toBe(error);
			else expect(actual).toMatchObject({ message: "cannot inspect" });
		}
	});
});

for (const test of createTelemetryAdapterConformance(() => {
	const context = new InMemoryTelemetryContext();
	return Promise.resolve({
		context,
		propagation: context,
		metrics: context,
		getMetrics: async () => context.getMetrics(),
		getSpans: async () => context.getSpans(),
		async [Symbol.asyncDispose]() {},
	});
}))
	it(`${test.group}: ${test.name}`, test.run);
