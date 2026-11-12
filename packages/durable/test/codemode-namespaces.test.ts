import { expect, expectTypeOf, test } from "vitest";
import { Type } from "typebox";
import { namespacesOf, type CodemodeToolOptions } from "../src/codemode/index.ts";
import { codemodeSection } from "../src/codemode/describe.ts";
import { defineTool, type Extension, type ToolNamespace } from "../src/index.ts";

const tool = (name: string) =>
	defineTool({
		name,
		description: `Perform ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ output: [] }),
	});

test("the first extension owns each tool even when it supplies no namespace", () => {
	expectTypeOf<CodemodeToolOptions>().not.toHaveProperty("namespaces");
	const shared = tool("shared"),
		probe = tool("probe");
	const namespace: ToolNamespace = { name: "remote", description: "Remote operations" };
	const ungrouped: Extension = { name: "local", tools: [shared] };
	const grouped: Extension = { name: "remote", namespace, tools: [shared, probe] };
	expect([...namespacesOf([ungrouped, grouped])]).toEqual([["probe", namespace]]);
	expect([...namespacesOf([grouped, ungrouped])]).toEqual([
		["shared", namespace],
		["probe", namespace],
	]);
	expect(namespacesOf([{ name: "empty", namespace }]).size).toBe(0);
});

test("namespace headings stay stable when deferred tools arrive and declarations exhaust their budget", () => {
	const read = tool("read");
	const local: Extension = { name: "local", tools: [read] };
	const first: Extension = {
		name: "first",
		namespace: { name: "alpha", description: "  First catalog  ", instructions: "Detailed private instructions" },
	};
	const server: Extension = { name: "server", namespace: { name: "zulu", description: "Waiting for remote tools" } };
	const duplicate: Extension = { name: "duplicate", namespace: { name: "alpha", description: "Ignored replacement" } };
	const extensions = [local, server, first, duplicate];
	const before = codemodeSection([read], extensions, 1000);
	expect(before).toBeDefined();
	expect(before).toContain("### `read`");
	expect(before).toContain("## alpha\nFirst catalog");
	expect(before).toContain("## zulu\nWaiting for remote tools");
	expect(before).not.toContain("Detailed private instructions");
	expect(before).not.toContain("Ignored replacement");
	expect(before!.indexOf("### `read`")).toBeLessThan(before!.indexOf("## alpha"));
	expect(before!.indexOf("## alpha")).toBeLessThan(before!.indexOf("## zulu"));
	const connected: Extension = { ...server, tools: [{ ...tool("remote_query"), deferred: true }] };
	expect(codemodeSection([read], [local, connected, first, duplicate], 1000)).toBe(before);
	const limited = codemodeSection([read], extensions, 0);
	expect(limited).toContain("Some tools are not listed: find them with `searchTools()`.");
	expect(limited).not.toContain("### `read`");
	expect(limited).not.toContain("not listed)");
	expect(limited).toContain("## alpha\nFirst catalog");
	expect(limited).toContain("## zulu\nWaiting for remote tools");
	expect(codemodeSection([], [local], 1000)).toBeUndefined();
});
