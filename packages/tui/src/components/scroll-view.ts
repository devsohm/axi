import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { Container, type Component } from "../tui.ts";
export type ScrollViewScrollbar = "hidden" | "auto" | "always";
export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}
export interface ScrollViewScrollToOptions {
	disableFollow?: boolean;
}
export class ScrollView extends Container {
	readonly #child: Component;
	readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	#scrollbar: ScrollViewScrollbar;
	readonly #delay: number;
	#top = 0;
	#height = 0;
	#viewport = 0;
	#following: boolean;
	#suppressed = false;
	#redraw: (() => void) | undefined;
	#transient = false;
	#active = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical")
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		this.#child = component;
		this.children.push(component);
		this.followEnd = options.follow === "end";
		this.#following = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.#scrollbar = options.scrollbar ?? "hidden";
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		this.#delay = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}
	get scrollTop(): number {
		return this.#top;
	}
	get isFollowingEnd(): boolean {
		return this.#following;
	}
	get viewportHeight(): number {
		return this.#viewport;
	}
	get scrollbar(): ScrollViewScrollbar {
		return this.#scrollbar;
	}
	get isScrollbarActive(): boolean {
		return this.#active;
	}
	get isScrollbarVisible(): boolean {
		return this.#scrollbar === "always"
			? this.#viewport > 0
			: this.#scrollbar === "auto" && this.#height > this.#viewport && this.#transient;
	}
	#hide(): void {
		this.#transient = false;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
	#activity(): void {
		if (this.#scrollbar !== "auto" || this.#height <= this.#viewport) return;
		this.#transient = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#active) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#transient = false;
			this.#redraw?.();
		}, this.#delay);
		this.#timer.unref();
	}
	setScrollbar(value: ScrollViewScrollbar): void {
		if (value === this.#scrollbar) return;
		this.#scrollbar = value;
		if (value !== "auto") this.#hide();
		else if (this.#active) this.#activity();
		this.#redraw?.();
	}
	setScrollbarActive(value: boolean): void {
		if (value === this.#active) return;
		this.#active = value;
		this.#activity();
		this.#redraw?.();
	}
	getContentWidth(width: number): number {
		return this.#scrollbar === "always" && width > 1 ? width - 1 : width;
	}
	scrollTo(value: number, options: ScrollViewScrollToOptions = {}): void {
		const max = Math.max(0, this.#height - this.#viewport),
			next = Math.max(0, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : this.#top));
		const suppressed = options.disableFollow === true && next === max,
			following = !suppressed && this.followEnd && next === max;
		if (next === this.#top && suppressed === this.#suppressed && following === this.#following) return;
		const moved = next !== this.#top;
		this.#top = next;
		this.#suppressed = suppressed;
		this.#following = following;
		if (moved) this.#activity();
		this.#redraw?.();
	}
	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (!requested) return 0;
		const max = Math.max(0, this.#height - this.#viewport),
			start = this.#following ? max : this.#top,
			next = Math.max(0, Math.min(max, start + requested));
		const moved = next - start,
			follow = this.#following;
		this.#top = next;
		this.#following = this.followEnd && next === max;
		this.#suppressed = false;
		if (moved) this.#activity();
		if (moved || follow !== this.#following) this.#redraw?.();
		return requested - moved;
	}
	scrollToStart(): void {
		const follow = this.followEnd && this.#height <= this.#viewport,
			changed = this.#top !== 0 || this.#following !== follow;
		this.#top = 0;
		this.#following = follow;
		this.#suppressed = false;
		if (changed) {
			this.#activity();
			this.#redraw?.();
		}
	}
	scrollToEnd(): void {
		const next = Math.max(0, this.#height - this.#viewport),
			changed = next !== this.#top || this.#following !== this.followEnd;
		this.#top = next;
		this.#following = this.followEnd;
		this.#suppressed = false;
		if (changed) {
			this.#activity();
			this.#redraw?.();
		}
	}
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.#height = Math.max(0, Math.floor(contentHeight));
		this.#viewport = Math.max(0, Math.floor(viewportHeight));
		this.#redraw = requestRender;
		const max = Math.max(0, this.#height - this.#viewport);
		this.#top = this.#following ? max : Math.max(0, Math.min(max, this.#top));
		if (this.#top < max) this.#suppressed = false;
		if (this.followEnd && this.#top === max && !this.#suppressed) this.#following = true;
		if (this.#height <= this.#viewport) this.#hide();
	}
	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}
	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}
	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}
	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width),
			lines = this.#child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}
	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.#child, state: this };
	}
}
