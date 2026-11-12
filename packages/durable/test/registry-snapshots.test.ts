import { Type } from "typebox";
import { expect, it } from "vitest";
import {
	CompactionTask,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	section,
	ToolTask,
	type Extension,
} from "../src/index.ts";

const inspect = defineTool({
	name: "inspect",
	description: "Inspect an item",
	parameters: Type.Object({}),
	async execute() {
		return { output: [] };
	},
});
const indexer = (version: number) =>
	defineTask<null, { phase: "scan" }, null>({
		name: "app.indexer",
		version,
		initial: () => ({ phase: "scan" }),
		phases: { scan: async () => {} },
		abort: async () => {},
	});

it("keeps invocation snapshots stable through replacement, removal and reinstallation", () => {
	const registry = createRegistry();
	const notices: string[][] = [];
	const stop = registry.subscribe(() =>
		notices.push(
			registry
				.snapshot()
				.installed()
				.map((item) => item.name),
		),
	);
	const firstTask = indexer(1),
		nextTask = indexer(2);
	const original = defineExtension({
		name: "search",
		tools: [inspect],
		tasks: [firstTask],
		sections: [section("catalog", () => "old")],
	});
	const empty = defineExtension({ name: "audit" });
	registry.install(original);
	registry.install(empty);
	const invocation = registry.snapshot();
	const replacement = defineExtension({
		name: "search",
		tasks: [nextTask],
		tools: [{ ...inspect, name: "locate" }],
		sections: [section("catalog", () => "new")],
	});
	registry.install(replacement);
	expect(registry.snapshot().installed()).toEqual([replacement, empty]);
	expect(registry.snapshot().tools()).toEqual([{ extension: replacement, tool: replacement.tools![0] }]);
	expect(registry.snapshot().sections()).toEqual([{ extension: replacement, section: replacement.sections![0] }]);
	expect(registry.snapshot().task("app.indexer")).toBe(nextTask);
	registry.uninstall(original);
	registry.uninstall(original);
	expect(registry.snapshot().installed()).toEqual([empty]);
	expect(registry.snapshot().tools()).toEqual([]);
	expect(registry.snapshot().sections()).toEqual([]);
	expect(registry.snapshot().task("app.indexer")).toBeUndefined();
	expect(registry.snapshot().tasks()).toEqual([GenerationTask, ToolTask, CompactionTask]);
	registry.install(original);
	expect(registry.snapshot().installed()).toEqual([empty, original]);
	expect(invocation.extension("search")).toBe(original);
	expect(invocation.extension("absent")).toBeUndefined();
	expect(invocation.installed()).toEqual([original, empty]);
	expect(invocation.tools()).toEqual([{ extension: original, tool: inspect }]);
	expect(invocation.sections()).toEqual([{ extension: original, section: original.sections![0] }]);
	expect(invocation.tasks()).toEqual([GenerationTask, ToolTask, CompactionTask, firstTask]);
	expect(invocation.task("app.indexer")).toBe(firstTask);
	expect(notices).toEqual([["search"], ["search", "audit"], ["search", "audit"], ["audit"], ["audit", "search"]]);
	stop();
	registry.uninstall(empty);
	expect(notices).toHaveLength(5);
});

it("rejects invalid replacements without publishing or losing a previously installed task", () => {
	const registry = createRegistry();
	const previous = defineExtension({ name: "search", tools: [inspect], tasks: [indexer(1)] });
	registry.install(previous);
	const before = registry.snapshot();
	let notices = 0;
	registry.subscribe(() => {
		notices++;
	});
	const invalid: Extension[] = [
		{ name: "search", tools: [inspect, inspect] },
		{ name: "search", sections: [section("catalog", () => "first"), section("catalog", () => "second")] },
		{ name: "search", sections: [section("Bad Key", () => "invalid")] },
		{ name: "search", sections: [section("instructions", () => "reserved")] },
		{ name: "search", tasks: [GenerationTask] },
		{ name: "other", tasks: [indexer(2)] },
	];
	for (const extension of invalid) {
		expect(() => registry.install(extension)).toThrow();
		expect(registry.snapshot()).toBe(before);
		expect(registry.snapshot().extension("search")).toBe(previous);
		expect(registry.snapshot().task("app.indexer")?.definition.version).toBe(1);
	}
	expect(notices).toBe(0);
});

it("exposes an already-published snapshot when a synchronous subscriber throws", () => {
	const registry = createRegistry(),
		failure = new Error("subscriber stopped");
	const extension = defineExtension({ name: "installed" });
	const stop = registry.subscribe(() => {
		throw failure;
	});
	expect(() => registry.install(extension)).toThrow(failure);
	expect(registry.snapshot().extension("installed")).toBe(extension);
	stop();
	registry.uninstall(extension);
	expect(registry.snapshot().extension("installed")).toBeUndefined();
});
