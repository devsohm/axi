import { expect, test } from "vitest";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";

const plain = (text: string) => text;

test("selection page keys move by the visible count and report only changed selections", () => {
	const list = new SelectList(
		Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: String(index) })),
		5,
		{ selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
	);
	const selected: string[] = [];
	list.onSelectionChange = (item) => selected.push(item.value);
	for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);
	expect(selected).toEqual(["5", "10", "11", "6"]);
	expect(list.getSelectedItem()?.value).toBe("6");
	expect(list.capturesViewportInput).toBe(true);
});

test("settings page keys retain the selected row until confirmation", () => {
	const changes: string[] = [];
	const list = new SettingsList(
		Array.from({ length: 12 }, (_, index) => ({
			id: String(index),
			label: String(index),
			currentValue: "off",
			values: ["off", "on"],
		})),
		5,
		{ label: plain, value: plain, description: plain, cursor: "> ", hint: plain },
		(id, value) => changes.push(id + ":" + value),
		() => {},
	);
	list.handleInput("\x1b[6~");
	list.handleInput("\r");
	expect(changes).toEqual(["5:on"]);
	expect(list.capturesViewportInput).toBe(true);
});
