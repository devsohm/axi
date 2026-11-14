import { expect, test } from "vitest";
import { contentText, getSystemMessageText, renderSystemMessageUpdate } from "../src/index.ts";
import { ownedSlice } from "../src/utils/text.ts";
import type { SystemMessage } from "../src/types.ts";

test("text extraction preserves order and separators while omitting non-text content", () => {
	expect(contentText("unchanged", "|")).toBe("unchanged");
	const blocks = [
		{ type: "text", text: "first" },
		{ type: "image", mimeType: "image/png", data: "AQID" },
		{ type: "thinking", thinking: "private reasoning" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		{ type: "text", text: "second" },
	] as const;
	expect(contentText(blocks)).toBe("first\nsecond");
	expect(contentText(blocks, "|")).toBe("first|second");
	expect(contentText(blocks.slice(1, 4))).toBe("");
	expect(contentText([])).toBe("");
});

test("the current system prompt omits removed and empty sections without changing section order", () => {
	const message: SystemMessage = {
		role: "system",
		timestamp: 1,
		content: [
			{ type: "text", text: "Base" },
			{ type: "text", text: "More" },
		],
		sections: { first: "First", removed: null, empty: "", last: "Last" },
	};
	expect(getSystemMessageText(message)).toBe("Base\nMore\n\nFirst\n\nLast");
	expect(getSystemMessageText({ role: "system", timestamp: 2, content: "" })).toBe("");
});

test("system updates distinguish removal from replacing a section with empty text", () => {
	expect(
		renderSystemMessageUpdate({
			role: "system",
			timestamp: 1,
			content: "Announcement",
			sections: { previous: null, active: "New instructions", empty: "" },
		}),
	).toBe(
		'Announcement\n\nRemoved system prompt section "previous".\n\nUpdated system prompt section "active":\n\nNew instructions\n\nUpdated system prompt section "empty":\n\n',
	);
	expect(renderSystemMessageUpdate({ role: "system", timestamp: 2, content: [] })).toBe("");
});

test("owned text slices preserve JavaScript string indexing with an optional end", () => {
	expect(ownedSlice("a🙂bc", 1)).toBe("🙂bc");
	expect(ownedSlice("a🙂bc", 1, 3)).toBe("🙂");
	expect(ownedSlice("abc", -2)).toBe("bc");
	expect(ownedSlice("abc", 2, 1)).toBe("");
});
