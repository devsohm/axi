import { expect, test } from "vitest";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { WheelScrollAccelerator } from "../src/wheel-scroll.ts";

const theme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};
const wheel: TuiMouseEvent = {
	type: "wheel",
	button: "none",
	x: 0,
	y: 0,
	screenX: 0,
	screenY: 0,
	width: 40,
	height: 10,
	shift: false,
	alt: false,
	ctrl: false,
	wheelDelta: 1,
};

test.each([false, true])("empty settings remain navigable and cancellable with search %s", (enableSearch) => {
	let cancelled = 0;
	const changes: string[] = [];
	const settings = new SettingsList(
		[],
		3,
		theme,
		(id) => changes.push(id),
		() => cancelled++,
		{ enableSearch },
	);
	expect(settings.render(80).join("\n")).toContain("No settings available");
	for (const key of ["\x1b[A", "\x1b[B", "\r", " "]) settings.handleInput(key);
	expect(settings.handleMouse({ ...wheel, y: 2 })).toBeUndefined();
	settings.handleInput("\x1b");
	expect(changes).toEqual([]);
	expect(cancelled).toBe(1);
});

test("settings wrap keyboard selection, clamp wheel selection and wrap the selected description", () => {
	const changes: [string, string][] = [];
	const settings = new SettingsList(
		["one", "two", "three"].map((id) => ({
			id,
			label: id,
			currentValue: "off",
			values: ["off", "on"],
			description: id === "one" ? "A description that wraps across several terminal rows." : undefined,
		})),
		3,
		theme,
		(id, value) => changes.push([id, value]),
		() => {},
	);
	for (const key of ["\x1b[A", "\r", "\x1b[B", "\r", "\x1b[B", "\r"]) settings.handleInput(key);
	expect(changes).toEqual([
		["three", "on"],
		["one", "on"],
		["two", "on"],
	]);
	settings.selectItem("one");
	const lines = settings.render(24);
	expect(lines.join("\n")).toContain("A description");
	expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	expect(settings.handleMouse({ ...wheel, wheelDelta: -1 })).toEqual({ handled: true, render: false });
	expect(settings.handleMouse(wheel)).toEqual({ handled: true, render: true });
	expect(settings.handleMouse(wheel)).toEqual({ handled: true, render: true });
	expect(settings.handleMouse(wheel)).toEqual({ handled: true, render: false });
	expect(settings.handleMouse({ ...wheel, wheelDelta: -1 })).toEqual({ handled: true, render: true });
	settings.handleInput("\r");
	expect(changes.at(-1)).toEqual(["two", "off"]);
	expect(settings.handleMouse({ ...wheel, type: "move" })).toBeUndefined();
	expect(settings.handleMouse({ ...wheel, type: "click", button: "right" })).toBeUndefined();
	expect(settings.handleMouse({ ...wheel, type: "click", button: "left", y: 9 })).toBeUndefined();
});

test("search field spacing does not activate or move a setting", () => {
	const changes: string[] = [];
	const settings = new SettingsList(
		[{ id: "one", label: "One", currentValue: "off", values: ["off", "on"] }],
		3,
		theme,
		(id) => changes.push(id),
		() => {},
		{ enableSearch: true },
	);
	expect(settings.handleMouse({ ...wheel, y: 1 })).toBeUndefined();
	settings.handleInput("not present");
	expect(settings.render(40).join("\n")).toContain("No matching settings");
	expect(settings.handleMouse({ ...wheel, y: 2 })).toBeUndefined();
	expect(changes).toEqual([]);
});

test("wheel acceleration carries fractional lines and resets for a direction change or pause", () => {
	const scroll = new WheelScrollAccelerator("auto", true);
	expect([0, 40, 80, 120].map((time) => scroll.next(1, time))).toEqual([1, 2, 3, 2]);
	expect(scroll.next(-1, 160)).toBe(1);
	expect(scroll.next(-1, 180)).toBe(5);
	expect(scroll.next(-1, 182)).toBe(1);
	expect(scroll.next(-1, 500)).toBe(1);
	expect(scroll.next(-1, 505)).toBe(6);
	scroll.setLines(3.9);
	expect(scroll.next(1, 510)).toBe(3);
	scroll.setLines("auto");
	expect(scroll.next(1, 520)).toBe(1);
});

test("fixed wheel settings have a one-line minimum and existing terminal acceleration is preserved", () => {
	const scroll = new WheelScrollAccelerator("auto", false);
	expect([0, 10, 20].map((time) => scroll.next(1, time))).toEqual([1, 1, 1]);
	for (const value of [0, -1, NaN, Infinity]) {
		scroll.setLines(value);
		expect(scroll.next(1, 30)).toBe(1);
	}
});
