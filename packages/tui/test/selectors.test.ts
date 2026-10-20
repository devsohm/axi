import { expect, test } from "vitest";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

const plain = (text: string) => text;
const mouse = (type: TuiMouseEvent["type"], y: number, wheelDelta?: number): TuiMouseEvent => ({
	type,
	button: "left",
	x: 1,
	y,
	screenX: 1,
	screenY: y,
	width: 50,
	height: 8,
	shift: false,
	alt: false,
	ctrl: false,
	...(wheelDelta === undefined ? {} : { wheelDelta }),
});

test("selector wraps keys, filters values, clips descriptions and confirms the pressed row", () => {
	const events: string[] = [];
	const items = [
		{ value: "alpha", label: "Alpha", description: "first\nchoice" },
		{ value: "beta", label: "Beta", description: "second" },
		{ value: "gamma", label: "Gamma", description: "third" },
	];
	const list = new SelectList(
		items,
		2,
		{ selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
		{ minPrimaryColumnWidth: 10 },
	);
	list.onSelectionChange = (item) => events.push(`focus:${item.value}`);
	list.onSelect = (item) => events.push(`select:${item.value}`);
	list.onCancel = () => events.push("cancel");
	expect(list.render(50)[0]).toBe("→ Alpha     first choice");
	list.handleInput("\x1b[A");
	expect(list.getSelectedItem()?.value).toBe("gamma");
	list.handleInput("\x1b[B");
	expect(list.getSelectedItem()?.value).toBe("alpha");
	list.handleMouse(mouse("press", 1));
	list.handleMouse(mouse("click", 0));
	list.handleInput("\x1b");
	expect(events).toEqual(["focus:gamma", "focus:alpha", "focus:beta", "select:beta", "cancel"]);
	list.setFilter("GA");
	expect(list.getSelectedItem()?.value).toBe("gamma");
	list.handleInput("\r");
	expect(events.at(-1)).toBe("select:gamma");
	expect(list.render(7).every((row) => visibleWidth(row) <= 7)).toBe(true);
	list.setFilter("absent");
	expect(list.getSelectedItem()).toBeNull();
	expect(list.render(50)).toEqual(["  No matching commands"]);
});

test("searchable settings cycle values, accept mouse changes and cancel without activating missing rows", () => {
	const events: string[] = [];
	const settings = new SettingsList(
		[
			{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
			{ id: "model", label: "Model", currentValue: "fast", values: ["fast", "large"] },
		],
		3,
		{ label: plain, value: plain, description: plain, hint: plain, cursor: "> " },
		(id, value) => events.push(`${id}:${value}`),
		() => events.push("cancel"),
		{ enableSearch: true },
	);
	settings.handleInput("mdl");
	expect(settings.render(40).some((row) => row.includes("Model"))).toBe(true);
	expect(settings.render(40).some((row) => row.includes("Theme"))).toBe(false);
	settings.handleInput("\r");
	expect(events).toEqual(["model:large"]);
	settings.handleMouse(mouse("press", 2));
	settings.handleMouse(mouse("click", 2));
	expect(events).toEqual(["model:large", "model:fast"]);
	settings.updateValue("model", "large");
	expect(settings.render(40)[2]).toContain("large");
	settings.handleInput("xyz");
	expect(settings.render(40)).toContain("  No matching settings");
	settings.handleInput("\r");
	settings.handleInput("\x1b");
	expect(events).toEqual(["model:large", "model:fast", "cancel"]);
});
