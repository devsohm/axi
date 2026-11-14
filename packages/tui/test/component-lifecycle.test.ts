import { expect, test, vi } from "vitest";
import { Box } from "../src/components/box.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { SettingsList, type SettingItem } from "../src/components/settings-list.ts";
import { AltScreenFlashContainer } from "../src/components/alt-screen-flash.ts";
import { HStack } from "../src/components/h-stack.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Spacer } from "../src/components/spacer.ts";
import { TruncatedText } from "../src/components/truncated-text.ts";
import { SelectList } from "../src/components/select-list.ts";
import { Text } from "../src/components/text.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { dispatchMouseEvent, type Component, type TuiMouseEvent } from "../src/tui.ts";

function mouse(x = 1, y = 1, type: TuiMouseEvent["type"] = "press"): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: 20 + x,
		screenY: 30 + y,
		width: 10,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

test("text repainting follows explicit background changes and preserves its content", () => {
	const text = new Text("value", 0, 0);
	expect(text.render(7)).toEqual(["value  "]);
	text.setCustomBgFn((line) => "\x1b[44m" + line + "\x1b[49m");
	expect(text.render(7)).toEqual(["\x1b[44mvalue  \x1b[49m"]);
	text.setText("value");
	expect(text.render(7)).toEqual(["\x1b[44mvalue  \x1b[49m"]);
	text.setCustomBgFn();
	expect(text.render(7)).toEqual(["value  "]);
	text.setText(" ");
	expect(text.render(7)).toEqual([]);
});

test("empty text and a padded single-line label preserve their reserved space", () => {
	expect(new Text().render(8)).toEqual([]);
	const label = new TruncatedText("ok\nignored", 1, 1);
	expect(label.render(8)).toEqual(["        ", " ok     ", "        "]);
	label.invalidate();
	expect(label.render(8)).toEqual(["        ", " ok     ", "        "]);
});

test("direct horizontal rendering centers a short child beside three lines", () => {
	const row = new HStack([
		{ component: new Text("x", 0, 0), basis: 1, shrink: 0 },
		{ component: new Text("one\ntwo\nend", 0, 0), basis: 3, shrink: 0 },
	], { align: "center", gap: 1 });
	expect(row.render(5).map(stripTerminalSequences)).toEqual(["  one", "x two", "  end"]);
});

test("direct vertical rendering reserves child height separately from the gap", () => {
	const column = new VStack([
		{ component: new Text("one", 0, 0), basis: 3 },
		new Text("two", 0, 0),
	], { gap: 2 });
	expect(column.render(5)).toEqual(["one  ", "", "", "", "", "two  "]);
});

test("stack edits and invalidation preserve selection while flash messages expire and dispose", () => {
	vi.useFakeTimers();
	const redraw = vi.fn();
	const flash = new AltScreenFlashContainer(redraw);
	try {
		const label = new Text("left", 0, 0);
		const badge = new TruncatedText("wide\nhidden");
		const row = new HStack([
			{ component: label, basis: 4, shrink: 0 },
			{ component: badge, basis: 4, shrink: 0 },
		]);
		const plain = (value: string) => value;
		const menu = new SelectList(
			[
				{ label: "first", value: "first" },
				{ label: "second", value: "second" },
			],
			2,
			{
				selectedPrefix: plain,
				selectedText: plain,
				description: plain,
				scrollInfo: plain,
				noMatch: plain,
			},
		);
		menu.setSelectedIndex(1);
		const body = new VStack([row, new Spacer(), flash, menu]);
		flash.flash("saved", 10);
		body.invalidate();
		expect(
			body
				.render(8)
				.map(stripTerminalSequences)
				.map((line) => line.trimEnd())
				.slice(0, 3),
		).toEqual(["leftwide", "", " saved"]);
		expect(menu.getSelectedItem()?.value).toBe("second");
		row.removeChild(new Text("unrelated"));
		expect(row.children).toEqual([label, badge]);
		row.removeChild(badge);
		expect(
			row
				.render(8)
				.map(stripTerminalSequences)
				.map((line) => line.trimEnd()),
		).toEqual(["left"]);
		row.clear();
		expect(row.render(8)).toEqual([]);
		vi.advanceTimersByTime(10);
		expect(flash.render(8)).toEqual([]);
		expect(redraw).toHaveBeenCalledTimes(2);
		flash.flash("later", 10);
		flash.dispose();
		vi.advanceTimersByTime(1000);
		expect(redraw).toHaveBeenCalledTimes(3);
		body.clear();
		expect(body.render(8)).toEqual([]);
	} finally {
		flash.dispose();
		vi.useRealTimers();
	}
});

test("mouse regions delegate to handled children and fall back without swallowing unused events", () => {
	const render = vi.fn(() => ["content"]),
		invalidate = vi.fn(),
		fallback = vi.fn(() => ({ handled: true }));
	const child: Component = { render, invalidate, handleMouse: () => ({ focus: true }) };
	const region = new MouseRegion(child, fallback);
	expect(region.render(12)).toEqual(["content"]);
	expect(render).toHaveBeenCalledWith(12);
	region.invalidate();
	expect(invalidate).toHaveBeenCalledOnce();
	const handled = region.handleMouse(mouse());
	expect(handled).toMatchObject({
		handled: true,
		focus: true,
		focusTarget: child,
		target: { component: child, originX: 20, originY: 30 },
	});
	expect(fallback).not.toHaveBeenCalled();
	child.handleMouse = () => ({ render: true });
	expect(region.handleMouse(mouse())).toEqual({ handled: true });
	expect(fallback).toHaveBeenCalledOnce();
	const inert = new MouseRegion({ render, invalidate }, () => undefined);
	expect(dispatchMouseEvent(inert, mouse())).toBeUndefined();
});

test("boxes paint padding, update mutable content and background, and remove only their own children", () => {
	let content = ["one"],
		color = "a";
	const child: Component = { render: () => content, invalidate: vi.fn() };
	const box = new Box(1, 1, (text) => `${color}:${text}`);
	expect(box.render(8)).toEqual([]);
	box.addChild(child);
	expect(box.render(8)).toEqual(["a:        ", "a: one    ", "a:        "]);
	expect(box.render(8)).toEqual(["a:        ", "a: one    ", "a:        "]);
	content = ["two", "end"];
	expect(box.render(8)).toEqual(["a:        ", "a: two    ", "a: end    ", "a:        "]);
	color = "b";
	expect(box.render(8)[1]).toBe("b: two    ");
	box.setBgFn();
	box.setPaddingX(2);
	expect(box.render(8)[1]).toBe("  two   ");
	box.invalidate();
	expect(child.invalidate).toHaveBeenCalledOnce();
	box.removeChild({ render: () => [], invalidate() {} });
	expect(box.children).toEqual([child]);
	box.removeChild(child);
	expect(box.render(8)).toEqual([]);
	box.addChild({ render: () => [], invalidate() {} });
	expect(box.render(8)).toEqual([]);
	box.clear();
	expect(box.children).toEqual([]);
});

test("box mouse coordinates account for padding and each child's height before and after rendering", () => {
	const selected = vi.fn(() => ({ handled: true }));
	const box = new Box(1, 1);
	box.addChild({ render: () => ["first", "second"], invalidate() {} });
	const child: Component = { render: () => ["third"], invalidate() {}, handleMouse: selected };
	box.addChild(child);
	for (const painted of [false, true]) {
		if (painted) box.render(10);
		expect(box.handleMouse(mouse(2, 3))).toMatchObject({ target: { component: child, width: 8, height: 1 } });
		expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ x: 1, y: 0, width: 8, height: 1 }));
		for (const [x, y] of [
			[0, 1],
			[9, 1],
			[1, 0],
			[2, 4],
		])
			expect(box.handleMouse(mouse(x, y))).toBeUndefined();
	}
});

test("settings submenus forward input, accept values, navigate between controls and restore selection", () => {
	const plain = (text: string) => text,
		changed = vi.fn(),
		cancelled = vi.fn();
	let done: Parameters<NonNullable<SettingItem["submenu"]>>[1] | undefined;
	const submenu: Component = {
		render: () => ["submenu"],
		invalidate: vi.fn(),
		handleInput: vi.fn(),
		handleMouse: () => ({ handled: true }),
	};
	const settings = new SettingsList(
		[
			{
				id: "advanced",
				label: "Advanced",
				currentValue: "old",
				submenu: (_value, finish) => {
					done = finish;
					return submenu;
				},
			},
			{ id: "choice", label: "Choice", currentValue: "unknown", values: ["a", "b"] },
			{ id: "fixed", label: "Fixed", currentValue: "constant" },
		],
		2,
		{ label: plain, value: plain, description: plain, hint: plain, cursor: "> " },
		changed,
		cancelled,
	);
	settings.handleInput("\r");
	expect(settings.render(30)).toEqual(["submenu"]);
	settings.handleInput("x");
	expect(submenu.handleInput).toHaveBeenCalledWith("x");
	settings.invalidate();
	expect(submenu.invalidate).toHaveBeenCalledOnce();
	expect(settings.handleMouse(mouse())).toEqual({ handled: true, focus: true });
	if (!done) throw new Error("Submenu did not open");
	done("new", { navigateTo: "choice" });
	expect(changed.mock.calls).toEqual([
		["advanced", "new"],
		["choice", "a"],
	]);
	settings.handleInput("\r");
	expect(changed).toHaveBeenLastCalledWith("choice", "b");
	settings.selectItem("fixed");
	settings.handleInput("\r");
	expect(changed).toHaveBeenCalledTimes(3);
	settings.selectItem("advanced");
	settings.handleInput("\r");
	done();
	expect(settings.render(30)[0]).toContain("> Advanced");
	settings.handleInput("\x1b");
	expect(cancelled).toHaveBeenCalledOnce();
	settings.selectItem("absent");
	settings.updateValue("absent", "ignored");
	expect(settings.render(30)[0]).toContain("> Advanced");
});
