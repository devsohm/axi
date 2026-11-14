import { expect, test } from "vitest";
import { Type } from "typebox";
import type { Message, Tool } from "../src/types.ts";
import {
	getCurrentTools,
	getDeclaredTools,
	getToolStateChanges,
	hasNonAdditiveToolChanges,
	hasToolRedefinitions,
} from "../src/utils/transcript.ts";
import { ToolCallArgumentsStream } from "../src/utils/streaming-json.ts";

const tool: Tool = { name: "inspect", description: "Inspect", parameters: Type.Object({ path: Type.String() }) };
test.each([false, true])(
	"tool history distinguishes identical redeclarations from changed definitions %s",
	(changed) => {
		const next = { ...tool, description: changed ? "Inspect with context" : tool.description };
		const messages: Message[] = [
			{ role: "system", content: "Instructions", toolsAdded: [tool], timestamp: 0 },
			{ role: "user", content: "Work", timestamp: 1 },
			{ role: "system", content: "Updated", toolsAdded: [next], timestamp: 2 },
		];
		expect(hasToolRedefinitions(messages)).toBe(changed);
		expect(hasNonAdditiveToolChanges(messages)).toBe(true);
		expect(getCurrentTools(messages)).toEqual([next]);
		expect(getDeclaredTools(messages)).toEqual([next]);
		expect(getToolStateChanges([tool], [next])).toEqual(
			changed ? { toolsAdded: [next], toolsRemoved: [{ name: "inspect" }] } : { toolsAdded: [], toolsRemoved: [] },
		);
	},
);

test("removing a tool changes the available set without erasing its historical declaration", () => {
	const messages: Message[] = [
		{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
		{ role: "system", content: "", toolsRemoved: [{ name: tool.name }], timestamp: 1 },
	];
	expect(getCurrentTools(messages)).toEqual([]);
	expect(getDeclaredTools(messages)).toEqual([tool]);
	expect(hasToolRedefinitions(messages)).toBe(false);
	expect(hasNonAdditiveToolChanges(messages)).toBe(true);
});

test("streamed arguments retain the exact source text through appends and full replacements", () => {
	const stream = new ToolCallArgumentsStream();
	expect(stream.text).toBe("");
	stream.append('{"label":"a');
	stream.append('b"}');
	expect(stream.text).toBe('{"label":"ab"}');
	expect(stream.finish()).toEqual({ arguments: { label: "ab" } });
	stream.replace('{ "next": true }');
	expect(stream.text).toBe('{ "next": true }');
	expect(stream.finish()).toEqual({ arguments: { next: true } });
});
