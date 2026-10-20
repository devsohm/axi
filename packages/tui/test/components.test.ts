import { HStack } from "../src/components/h-stack.ts";
import { VStack } from "../src/components/v-stack.ts";
import { Spacer } from "../src/components/spacer.ts";
import { TruncatedText } from "../src/components/truncated-text.ts";
import { afterEach, expect, it, vi } from "vitest";
import { Box } from "../src/components/box.ts";
import { CancellableLoader } from "../src/components/cancellable-loader.ts";
import { Loader } from "../src/components/loader.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { stripTerminalSequences } from "../src/utils.ts";

afterEach(() => vi.useRealTimers());

it("updates a loader without recursive invalidation and stops its animation", () => {
	vi.useFakeTimers();
	const redraw = vi.fn();
	const loader = new Loader(
		{ requestRender: redraw },
		(text) => text,
		(text) => text,
		"Working",
		{ frames: ["a", "b"], intervalMs: 10 },
	);
	expect(loader.render(20)[1].trim()).toBe("a Working");
	vi.advanceTimersByTime(10);
	expect(loader.render(20)[1].trim()).toBe("b Working");
	loader.invalidate();
	loader.setMessage("Waiting");
	expect(loader.render(20)[1].trim()).toBe("b Waiting");
	loader.stop();
	const calls = redraw.mock.calls.length;
	vi.advanceTimersByTime(50);
	expect(redraw).toHaveBeenCalledTimes(calls);
});

it("delivers cancellation through the loader signal", () => {
	const loader = new CancellableLoader(
		{ requestRender() {} },
		(text) => text,
		(text) => text,
		"Waiting",
		{ frames: [] },
	);
	const abort = vi.fn();
	loader.onAbort = abort;
	loader.handleInput("\x1b");
	expect(loader.signal.aborted).toBe(true);
	expect(abort).toHaveBeenCalledOnce();
	loader.dispose();
});

it("invalidates rendered text and box padding when horizontal padding changes", () => {
	const text = new Text("hello", 1, 0);
	expect(text.render(12)).toEqual([" hello      "]);
	text.setPaddingX(0);
	expect(text.render(12)).toEqual(["hello       "]);
	const box = new Box(1, 0);
	box.addChild(new Text("x", 0, 0));
	expect(box.render(6)).toEqual([" x    "]);
	box.setPaddingX(0);
	expect(box.render(6)).toEqual(["x     "]);
});

it("accepts a submenu result and opens the requested next setting", () => {
	const changes: string[] = [];
	const theme: SettingsListTheme = {
		label: (text) => text,
		value: (text) => text,
		description: (text) => text,
		hint: (text) => text,
		cursor: "> ",
	};
	const settings = new SettingsList(
		[
			{
				id: "first",
				label: "First",
				currentValue: "old",
				submenu: (_value, done) => ({
					render: () => ["first submenu"],
					invalidate() {},
					handleInput() {
						done("new", { navigateTo: "second" });
					},
				}),
			},
			{
				id: "second",
				label: "Second",
				currentValue: "old",
				submenu: () => ({ render: () => ["second submenu"], invalidate() {} }),
			},
		],
		5,
		theme,
		(id, value) => changes.push(`${id}:${value}`),
		() => {},
	);
	settings.handleInput("\r");
	expect(settings.render(30)).toEqual(["first submenu"]);
	settings.handleInput("x");
	expect(changes).toEqual(["first:new"]);
	expect(settings.render(30).map(stripTerminalSequences)).toEqual(["second submenu"]);
});

it("horizontal and vertical composition clips text and updates reserved spacing", () => {
	const label = new Text("left", 0, 0),
		space = new Spacer(1);
	const row = new HStack(
		[
			{ component: label, basis: 4, shrink: 0 },
			{ component: new TruncatedText("long answer"), basis: 5, shrink: 0 },
		],
		{ gap: 1 },
	);
	const body = new VStack([row, space, new Text("tail", 0, 0)]);
	expect(body.render(10).map(stripTerminalSequences)).toEqual(["left lo...", "", "tail      "]);
	label.setText("go");
	space.setLines(0);
	expect(body.render(10).map(stripTerminalSequences)).toEqual(["go   lo...", "tail      "]);
});

it("paints every box row in display order without reusing a padding callback result", () => {
	const calls: string[] = [];
	const box = new Box(1, 1, (text) => {
		calls.push(text);
		return `${calls.length}:${text}`;
	});
	box.addChild({ render: () => ["x"], invalidate() {} });
	expect(box.render(4)).toEqual(["2:    ", "3: x  ", "4:    "]);
	expect(calls).toEqual(["test", "    ", " x  ", "    "]);
});

it("paints text content before its shared vertical padding", () => {
	const calls: string[] = [];
	const text = new Text("x", 1, 1, (line) => {
		calls.push(line);
		return `${calls.length}:${line}`;
	});
	expect(text.render(4)).toEqual(["2:    ", "1: x  ", "2:    "]);
	expect(calls).toEqual([" x  ", "    "]);
});
