import { dispatchMouseEvent, type Component, type TuiMouseEvent, type TuiMouseDispatchResult } from "../tui.ts";
import { flattenLines, visibleWidth } from "../utils.ts";

export class Box implements Component {
	children: Component[] = [];
	#layout: { width: number; entries: { component: Component; height: number }[] } | undefined;
	#paddingX: number;
	readonly #paddingY: number;
	#background: ((text: string) => string) | undefined;
	#cache: { width: number; sample: string | undefined; content: string[]; lines: string[] } | undefined;
	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#background = bgFn;
	}
	addChild(component: Component): void {
		this.children.push(component);
		this.#cache = undefined;
	}
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index < 0) return;
		this.children.splice(index, 1);
		this.#cache = undefined;
	}
	clear(): void {
		this.children = [];
		this.#cache = undefined;
	}
	setBgFn(background?: (text: string) => string): void {
		this.#background = background;
	}
	setPaddingX(paddingX: number): void {
		this.#paddingX = paddingX;
		this.#cache = undefined;
	}
	invalidate(): void {
		this.#cache = undefined;
		for (const component of this.children) component.invalidate?.();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const width = Math.max(1, event.width - 2 * this.#paddingX);
		const x = event.x - this.#paddingX,
			y = event.y - this.#paddingY;
		if (x < 0 || x >= width || y < 0) return undefined;
		const entries =
			this.#layout?.width === width
				? this.#layout.entries
				: this.children.map((component) => ({ component, height: component.render(width).length }));
		let offset = 0;
		for (const { component, height } of entries) {
			if (y >= offset && y < offset + height)
				return dispatchMouseEvent(component, { ...event, x, y: y - offset, width, height });
			offset += height;
		}
		return undefined;
	}
	render(width: number): string[] {
		if (!this.children.length) return [];
		const contentWidth = Math.max(1, width - 2 * this.#paddingX);
		const content: string[] = [],
			entries: { component: Component; height: number }[] = [];
		for (const component of this.children) {
			const lines = component.render(contentWidth);
			entries.push({ component, height: lines.length });
			for (const line of lines) content.push(line);
		}
		this.#layout = { width: contentWidth, entries };
		if (!content.length) return [];
		const sample = this.#background?.("test");
		if (
			this.#cache?.width === width &&
			this.#cache.sample === sample &&
			this.#cache.content.length === content.length &&
			this.#cache.content.every((line, index) => line === content[index])
		)
			return this.#cache.lines;
		const paint = (text: string): string => {
			const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
			return this.#background?.(padded) ?? padded;
		};
		const lines: string[] = [];
		for (let index = 0; index < this.#paddingY; index++) lines.push(paint(""));
		for (const line of content) lines.push(paint(" ".repeat(this.#paddingX) + line));
		for (let index = 0; index < this.#paddingY; index++) lines.push(paint(""));
		flattenLines(lines);
		this.#cache = { width, sample, content, lines };
		return lines;
	}
}
