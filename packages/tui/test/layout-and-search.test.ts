import { expect, test, vi, afterEach } from "vitest";
import { AltScreenSearchIndex, findAltScreenSearchMatches } from "../src/alt-screen-search.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { HStack } from "../src/components/h-stack.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import {
	getLayoutBoxesAt,
	getScrollViewBox,
	getScrollViewsAt,
	getScrollbarGeometry,
	renderLayoutFrame,
} from "../src/layout.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { AltScreenFlashContainer } from "../src/components/alt-screen-flash.ts";

afterEach(() => vi.useRealTimers());

test("a fixed dock stays below a growing, scrollable transcript", () => {
	const body = new Text("one\ntwo\nthree\nfour", 0, 0);
	const scroll = new ScrollView(body, { follow: "end", primary: true });
	const root = new VStack([
		{ component: scroll, basis: 0, grow: 1 },
		{ component: new Text("input", 0, 0), basis: 1, shrink: 0 },
	]);
	const frame = () =>
		renderLayoutFrame(root, 8, 3, () => {}).lines.map((line) => stripTerminalSequences(line).trimEnd());
	expect(frame()).toEqual(["three", "four", "input"]);
	scroll.scrollBy(-1);
	body.setText("one\ntwo\nthree\nfour\nfive");
	expect(frame()).toEqual(["two", "three", "input"]);
	scroll.scrollToEnd();
	expect(frame()).toEqual(["four", "five", "input"]);
});

test("a horizontal row inside a scroller uses the tallest intrinsic child", () => {
	const row = new HStack([
		{ component: new Text("one\ntwo\nthree", 0, 0), basis: 5, shrink: 0 },
		{ component: new Text("side", 0, 0), basis: 4, shrink: 0 },
	], { gap: 1, align: "end" });
	const scroll = new ScrollView(row);
	const render = () => renderLayoutFrame(scroll, 12, 2, () => {});
	const initial = render();
	expect(initial.root.children[0]!.rect.height).toBe(3);
	expect(initial.lines.map((line) => stripTerminalSequences(line).trimEnd())).toEqual(["one", "two"]);
	scroll.scrollToEnd();
	expect(render().lines.map((line) => stripTerminalSequences(line).trimEnd())).toEqual(["two", "three side"]);
});

test("transcript search maps normalized text to Unicode terminal cells and reuses unchanged results", () => {
	const lines = ["before 界", "🙂 after"];
	expect(findAltScreenSearchMatches(lines, "界 🙂")).toEqual([
		{
			segments: [
				{ row: 0, startCol: 7, endCol: 9 },
				{ row: 1, startCol: 0, endCol: 2 },
			],
		},
	]);
	const index = new AltScreenSearchIndex();
	const first = index.search(lines, "after");
	const second = index.search([...lines], "after");
	expect(second.changed).toBe(false);
	expect(second.matches).toBe(first.matches);
	expect(index.search(["changed"], "after").matches).toEqual([]);
});

test("an empty search does not read transcript lines", () => {
	const read = vi.fn(() => "transcript");
	const lines = ["transcript"];
	Object.defineProperty(lines, 0, { get: read });
	for (const query of ["", " ", "\t\n", "\u2003"]) expect(findAltScreenSearchMatches(lines, query)).toEqual([]);
	expect(read).not.toHaveBeenCalled();
});

test("flash expiry removes only the expired message and disposal cancels timers", () => {
	vi.useFakeTimers();
	const redraw = vi.fn(),
		flashes = new AltScreenFlashContainer(redraw);
	flashes.flash("first", 10);
	flashes.flash("second", 20);
	vi.advanceTimersByTime(10);
	expect(flashes.render(12).map(stripTerminalSequences)).toEqual([" second "]);
	flashes.dispose();
	const calls = redraw.mock.calls.length;
	vi.advanceTimersByTime(50);
	expect(flashes.render(12)).toEqual([]);
	expect(redraw).toHaveBeenCalledTimes(calls);
});

test("scroll targeting prefers the deepest view independently of paint layers", () => {
	const inner = new ScrollView(new Text("content", 0, 0));
	const outer = new ScrollView(inner);
	const frame = renderLayoutFrame(outer, 12, 3, () => {});
	frame.root.layer = 10;
	expect(getLayoutBoxesAt(frame, 0, 0)[0]?.scrollView).toBe(outer);
	expect(getScrollViewsAt(frame, 0, 0)).toEqual([inner, outer]);
});

test("transient scrollbars renew on movement, remain visible during drag and expire afterward", () => {
	vi.useFakeTimers();
	const redraw = vi.fn();
	const view = new ScrollView(new Text("one\ntwo\nthree\nfour", 0, 0), { scrollbar: "auto", scrollbarHideDelayMs: 10 });
	const frame = () => renderLayoutFrame(view, 8, 2, redraw);
	frame();
	expect(view.isScrollbarVisible).toBe(false);
	view.scrollBy(1);
	expect(view.isScrollbarVisible).toBe(true);
	vi.advanceTimersByTime(8);
	view.scrollBy(1);
	vi.advanceTimersByTime(8);
	expect(view.isScrollbarVisible).toBe(true);
	view.setScrollbarActive(true);
	vi.advanceTimersByTime(100);
	expect(view.isScrollbarVisible).toBe(true);
	expect(stripTerminalSequences(frame().lines[0])).toContain("█");
	view.setScrollbarActive(false);
	vi.advanceTimersByTime(10);
	expect(view.isScrollbarVisible).toBe(false);
	const box = getScrollViewBox(frame(), view);
	if (!box) throw new Error("The scroll view is absent from its layout");
	expect(getScrollbarGeometry(box)).toBeUndefined();
	expect(getScrollbarGeometry(box, true)).toMatchObject({ maxScrollTop: 2, thumbHeight: 2, trackHeight: 2 });
	expect(getScrollViewBox(frame(), new ScrollView(new Text("other")))).toBeUndefined();
});

test("scrollbar policy changes reserve space and cancel pending transient redraws", () => {
	vi.useFakeTimers();
	const redraw = vi.fn();
	const view = new ScrollView(new Text("one\ntwo\nthree", 0, 0), { scrollbar: "auto" });
	view.updateLayout(3, 1, redraw);
	view.scrollBy(1);
	view.setScrollbar("always");
	expect(view.getContentWidth(8)).toBe(7);
	const lines = view.render(8).map(stripTerminalSequences);
	expect(lines.map((line) => line.trimEnd())).toEqual(["one", "two", "three"]);
	expect(lines.map((line) => line.length)).toEqual([8, 8, 8]);
	const before = redraw.mock.calls.length;
	vi.advanceTimersByTime(2000);
	expect(redraw).toHaveBeenCalledTimes(before);
	view.setScrollbar("always");
	expect(redraw).toHaveBeenCalledTimes(before);
	view.setScrollbarActive(true);
	view.setScrollbar("auto");
	expect(view.isScrollbarVisible).toBe(true);
	view.setScrollbar("hidden");
	expect(view.isScrollbarVisible).toBe(false);
	view.updateLayout(1, 3, redraw);
	view.setScrollbar("auto");
	expect(view.isScrollbarVisible).toBe(false);
	expect(view.scrollBy(NaN)).toBe(0);
	expect(view.scrollBy(0)).toBe(0);
});

test("a scroll view retains its sole child when callers attempt structural changes", () => {
	const child = new Text("kept", 0, 0),
		view = new ScrollView(child);
	for (const change of [() => view.addChild(child), () => view.removeChild(child), () => view.clear()])
		expect(change).toThrow(/child/);
	expect(view.render(8).map((line) => line.trimEnd())).toEqual(["kept"]);
});

test.each(["start", "center", "end", "stretch"] as const)(
	"horizontal layout honors %s alignment inside a fixed viewport",
	(align) => {
		const side = new Text("x", 0, 0);
		const stack = new HStack(
			[
				{ component: side, basis: 2, shrink: 0 },
				{ component: new Text("one\ntwo\nend", 0, 0), grow: 1 },
				{ component: new Text("hidden"), basis: 0, maxSize: 0 },
			],
			{ align, gap: 1 },
		);
		const frame = renderLayoutFrame(stack, 10, 3, () => {});
		expect(frame.root.children[0]!.rect).toMatchObject({
			y: align === "end" ? 2 : align === "center" ? 1 : 0,
			height: align === "stretch" ? 3 : 1,
		});
		expect(frame.root.children[2]!.rect.width).toBe(0);
		expect(frame.lines.map(stripTerminalSequences).map((line) => line.trimEnd())).toEqual(
			align === "end"
				? ["   one", "   two", "x  end"]
				: align === "center"
					? ["   one", "x  two", "   end"]
					: ["x  one", "   two", "   end"],
		);
	},
);

test("clipped content keeps the input cursor in view rather than drawing the start of a long editor", () => {
	const editor = { render: () => ["old", "before", `now${CURSOR_MARKER}`], invalidate() {} };
	const frame = renderLayoutFrame(editor, 12, 2, () => {});
	expect(frame.lines.map(stripTerminalSequences)).toEqual(["before", "now"]);
	expect(frame.lines[1]).toContain(CURSOR_MARKER);
});

test("a scrolled image remains visible through decorated placeholder lines", async () => {
	const { encodeKitty, registerKittyImageMetadata } = await import("../src/terminal-image.ts");
	const imageId = 984312;
	registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 90, heightPx: 90 });
	const image = encodeKitty("AAAA", { imageId, columns: 2, rows: 3, moveCursor: false });
	const content = { render: () => ["heading", image, " | details", " | details", "tail", "end"], invalidate() {} };
	const view = new ScrollView(content, { follow: "end", primary: true });
	const frame = renderLayoutFrame(view, 20, 3, () => {});
	expect(view.scrollTop).toBe(3);
	expect(frame.lines[0]).toContain("i=984312");
	expect(frame.lines[0]).toContain("y=60,h=30,r=1");
});
