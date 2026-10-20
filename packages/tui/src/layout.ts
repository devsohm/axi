import type { ScrollView } from "./components/scroll-view.ts";
import { allocateStackSizes, visibleStackEntries } from "./components/stack.ts";
import { getLayoutNode } from "./layout-node.ts";
import { cropKittyImageLine, getKittyImageMetadata, isImageLine } from "./terminal-image.ts";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
import {
	extractAnsiCode,
	getActiveBackgroundAnsi,
	getGraphemeCellRange,
	sliceByColumn,
	visibleWidth,
} from "./utils.ts";
export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
	layer: number;
}
export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}
export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}
function clipRect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x),
		y = Math.max(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
		height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
	};
}
function shift(box: LayoutBox, dy: number): void {
	box.rect.y += dy;
	for (const child of box.children) shift(child, dy);
}
function reclip(box: LayoutBox, parent: LayoutRect): void {
	box.clip = clipRect(parent, box.rect);
	for (const child of box.children) reclip(child, box.clip);
}
class FrameBuilder {
	readonly width: number;
	readonly height: number;
	readonly redraw: () => void;
	readonly cache = new Map<Component, Map<number, string[]>>();
	primary: ScrollView | undefined;
	constructor(width: number, height: number, redraw: () => void) {
		this.width = width;
		this.height = height;
		this.redraw = redraw;
	}
	render(component: Component, width: number): string[] {
		width = Math.max(1, Math.floor(width));
		let widths = this.cache.get(component);
		if (!widths) {
			widths = new Map();
			this.cache.set(component, widths);
		}
		let lines = widths.get(width);
		if (!lines) {
			lines = component.render(width);
			widths.set(width, lines);
		}
		return lines;
	}
	box(
		component: Component,
		x: number,
		y: number,
		width: number,
		height: number | undefined,
		clip: LayoutRect,
	): LayoutBox {
		width = Math.max(1, Math.floor(width));
		const node = getLayoutNode(component);
		const result: LayoutBox = { component, rect: { x, y, width, height: 0 }, clip, children: [], layer: 0 };
		const finish = (allocated: number) => {
			result.rect.height = allocated;
			result.clip = clipRect(clip, result.rect);
			return result;
		};
		const attach = (child: LayoutBox) => {
			child.parent = result;
			result.children.push(child);
		};
		if (!node) {
			const lines = this.render(component, width),
				allocated = height === undefined ? lines.length : Math.max(0, Math.floor(height));
			const cursor =
				lines.length > allocated && allocated > 0 ? lines.findIndex((line) => line.includes(CURSOR_MARKER)) : -1;
			result.lines = lines;
			result.lineOffset = cursor >= allocated ? cursor - allocated + 1 : 0;
			return finish(allocated);
		}
		if (node.type === "scroll") {
			const old = node.state.scrollTop,
				contentWidth = node.state.getContentWidth(width);
			const child = this.box(node.component, x, y - old, contentWidth, undefined, clip);
			const allocated = height === undefined ? child.rect.height : Math.max(0, Math.floor(height));
			node.state.updateLayout(child.rect.height, allocated, this.redraw);
			shift(child, old - node.state.scrollTop);
			const view = node.state as ScrollView;
			if (view.primary || !this.primary) this.primary = view;
			result.scrollView = view;
			result.scrollContentLines = this.render(node.component, contentWidth);
			finish(allocated);
			attach(child);
			reclip(child, result.clip);
			return result;
		}
		const entries = visibleStackEntries(node.entries, { width: this.width, height: this.height });
		if (node.type === "vstack") {
			const sizes = allocateStackSizes(
				entries,
				entries.map((entry) =>
					typeof entry.basis === "number" ? entry.basis : this.render(entry.component, width).length,
				),
				height,
				node.gap,
			);
			finish(
				height === undefined
					? sizes.reduce((a, b) => a + b, 0) + Math.max(0, entries.length - 1) * node.gap
					: Math.max(0, Math.floor(height)),
			);
			let nextY = y;
			for (let index = 0; index < entries.length; index++) {
				attach(this.box(entries[index]!.component, x, nextY, width, sizes[index]!, result.clip));
				nextY += sizes[index]! + node.gap;
			}
		} else {
			const sizes = allocateStackSizes(
				entries,
				entries.map((entry) =>
					typeof entry.basis === "number"
						? entry.basis
						: this.render(entry.component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0),
				),
				width,
				node.gap,
			);
			const heights = entries.map((entry, index) => this.render(entry.component, Math.max(1, sizes[index]!)).length);
			const allocated = height === undefined ? heights.reduce((a, b) => Math.max(a, b), 0) : Math.max(0, height);
			finish(allocated);
			let nextX = x;
			for (let index = 0; index < entries.length; index++) {
				const childHeight = node.align === "stretch" ? allocated : Math.min(allocated, heights[index]!);
				const childY =
					y +
					(node.align === "end"
						? allocated - childHeight
						: node.align === "center"
							? Math.floor((allocated - childHeight) / 2)
							: 0);
				const childWidth = sizes[index]!;
				attach(
					childWidth === 0
						? {
								component: entries[index]!.component,
								rect: { x: nextX, y: childY, width: 0, height: childHeight },
								clip: { x: nextX, y: childY, width: 0, height: 0 },
								children: [],
								layer: 0,
							}
						: this.box(entries[index]!.component, nextX, childY, childWidth, childHeight, result.clip),
				);
				nextX += childWidth + node.gap;
			}
		}
		return result;
	}
}
export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	const view = box.scrollView,
		{ rect, clip } = box;
	if (!view || rect.width <= 0 || rect.height <= 0) return;
	const content = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	if (!view.isScrollbarVisible && !(includeHiddenAuto && view.scrollbar === "auto" && content > rect.height)) return;
	const trackHeight = rect.height,
		thumbHeight = Math.max(
			Math.min(2, trackHeight),
			Math.min(trackHeight, Math.round((trackHeight * trackHeight) / content)),
		);
	const maxScrollTop = Math.max(0, content - trackHeight),
		column = rect.x + rect.width - 1;
	if (column < clip.x || column >= clip.x + clip.width) return;
	return {
		column,
		trackTop: rect.y,
		trackHeight,
		thumbHeight,
		maxScrollTop,
		thumbTop:
			rect.y + (maxScrollTop === 0 ? 0 : Math.round((view.scrollTop / maxScrollTop) * (trackHeight - thumbHeight))),
	};
}
function scrollbarCell(line: string, column: number, width: number, replacement: string, preserve: boolean): string {
	if (isImageLine(line)) return line;
	const range = getGraphemeCellRange(line, column),
		start = range?.start ?? column,
		end = range?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true),
		target = sliceByColumn(line, start, end - start, true),
		after = sliceByColumn(line, end, Math.max(0, width - end), true);
	let prefix = "",
		offset = 0;
	for (let code = extractAnsiCode(target, offset); code; code = extractAnsiCode(target, offset)) {
		prefix += code.code;
		offset += code.length;
	}
	return (
		before +
		" ".repeat(Math.max(0, start - visibleWidth(before))) +
		"\x1b[0m\x1b]8;;\x07" +
		(preserve ? getActiveBackgroundAnsi(prefix) : "") +
		" ".repeat(Math.max(0, column - start)) +
		replacement +
		" ".repeat(Math.max(0, end - column - 1)) +
		after
	);
}
function paint(box: LayoutBox, screen: string[], width: number): void {
	const { rect, clip } = box;
	if (box.lines) {
		const from = Math.max(0, rect.y, clip.y),
			to = Math.min(screen.length, rect.y + rect.height, clip.y + clip.height);
		for (let row = from; row < to; row++) {
			const source = box.lines[(box.lineOffset ?? 0) + row - rect.y];
			if (source === undefined) continue;
			let line = source.replace(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/, "");
			const image = getKittyImageMetadata(line);
			if (image) {
				const rows = Math.min(image.rows, Math.min(screen.length, clip.y + clip.height) - row);
				if (rows < image.rows) line = cropKittyImageLine(line, 0, rows);
			}
			screen[row] =
				rect.x === 0 && rect.width >= width && (isImageLine(line) || !screen[row])
					? line
					: compositeTuiLine(screen[row] ?? "", line, rect.x, rect.width, width);
		}
	}
	for (const child of box.children) paint(child, screen, width);
	const view = box.scrollView;
	if (view && box.scrollContentLines && view.scrollTop > 0 && rect.height > 0) {
		for (let row = view.scrollTop - 1; row >= 0; row--) {
			const line = box.scrollContentLines[row] ?? "",
				image = getKittyImageMetadata(line);
			if (image) {
				const hidden = view.scrollTop - row;
				if (hidden < image.rows && rect.x === 0 && rect.width >= width)
					screen[rect.y] = cropKittyImageLine(line, hidden, Math.min(rect.height, image.rows - hidden));
				break;
			}
			if (line !== "") break;
		}
	}
	const bar = getScrollbarGeometry(box);
	if (bar && view) {
		for (let row = bar.trackTop; row < bar.trackTop + bar.trackHeight; row++) {
			if (row < clip.y || row >= clip.y + clip.height || row < 0 || row >= screen.length) continue;
			const thumb = row >= bar.thumbTop && row < bar.thumbTop + bar.thumbHeight;
			const replacement = thumb
				? view.scrollbarThumbStyle(view.isScrollbarActive ? "█" : "┃")
				: view.scrollbarTrackStyle("│");
			screen[row] = scrollbarCell(screen[row] ?? "", bar.column, width, replacement, view.scrollbar !== "always");
		}
	}
}
export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
): LayoutFrame {
	width = Math.max(1, Math.floor(width));
	height = Math.max(1, Math.floor(height));
	const builder = new FrameBuilder(width, height, requestRender),
		box = builder.box(root, 0, 0, width, height, { x: 0, y: 0, width, height });
	const lines = Array<string>(height).fill("");
	paint(box, lines, width);
	return { root: box, width, height, lines, ...(builder.primary ? { primaryScrollView: builder.primary } : {}) };
}
function contains(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
export function getLayoutBoxesAt(frame: LayoutFrame, x: number, y: number): LayoutBox[] {
	const found: { box: LayoutBox; depth: number }[] = [];
	const walk = (box: LayoutBox, depth: number) => {
		if (!contains(box.clip, x, y)) return;
		found.push({ box, depth });
		for (const child of box.children) walk(child, depth + 1);
	};
	walk(frame.root, 0);
	return found.sort((a, b) => b.box.layer - a.box.layer || b.depth - a.depth).map((item) => item.box);
}
export function getScrollViewBox(frame: LayoutFrame, view: ScrollView): LayoutBox | undefined {
	const pending = [frame.root];
	for (let box = pending.pop(); box; box = pending.pop()) {
		if (box.scrollView === view) return box;
		for (let index = box.children.length - 1; index >= 0; index--) pending.push(box.children[index]!);
	}
	return;
}
export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	return getLayoutBoxesAt(frame, x, y)
		.filter((box) => box.scrollView && contains(box.rect, x, y))
		.map((box) => box.scrollView!);
}
