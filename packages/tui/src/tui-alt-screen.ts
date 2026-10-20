import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	getAltScreenSearchMatchKey,
	type AltScreenSearchMatch,
} from "./alt-screen-search.ts";
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	renderLayoutFrame,
	type LayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	getKittyImagePlacementRows,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
	type ImageProtocol,
} from "./terminal-image.ts";
import {
	Container,
	CURSOR_MARKER,
	TuiBase,
	VIEWPORT_TUI,
	compositeTuiLine,
	dispatchMouseEvent,
	retargetMouseEvent,
	type Component,
	type OverlayHandle,
	type TuiMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

export interface TuiAltScreenOptions {
	wheelScrollLines?: WheelScrollLines;
	mouse?: boolean;
	searchMatchStyle?: (text: string) => string;
	searchCurrentMatchStyle?: (text: string) => string;
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	scrollToEndIndicator?: () => string;
	openUrl?: (url: string) => void;
	onRightClickPaste?: () => void;
	copyOnSelect?: boolean;
	copySelection?: (text: string) => Promise<boolean | string>;
}
type Mouse = { button: number; x: number; y: number; release: boolean };
type Point = { row: number; col: number; scrollView?: ScrollView; boundary?: boolean };
type Range = { start: Point; end: Point };
type Search = {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selected: number;
	key?: string;
	anchor: number;
	mode: "query" | "retain" | "next" | "previous";
};
const BEGIN = "\x1b[?2026h",
	END = "\x1b[?2026l",
	WRAP = "\x1b[?7h",
	NOWRAP = "\x1b[?7l";
const ENTER = "\x1b[?1049h",
	EXIT = "\x1b[?1049l",
	MOUSE_OFF = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const ZONE = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const PROMPT = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const words = getWordSegmenter();
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen";
	readonly [VIEWPORT_TUI] = true;
	#screen: string[] = [];
	#width = 0;
	#height = 0;
	#root: Component | undefined;
	#layout: LayoutFrame | undefined;
	readonly #document: Component;
	readonly #scroll: ScrollView;
	readonly #flashes: AltScreenFlashContainer;
	#active = false;
	#protocol: ImageProtocol = null;
	#saved: TerminalCapabilities | undefined;
	readonly #images = new Map<
		number,
		{ transmissionGeneration: number; transmissionBytes: number; estimatedDecodedBytes: number }
	>();
	readonly #wheel: WheelScrollAccelerator;
	readonly #options: TuiAltScreenOptions;
	#copyOnSelect: boolean;
	#anchor: Point | undefined;
	#focus: Point | undefined;
	#granularity: "character" | "word" | "line" = "character";
	#initial: Range | undefined;
	#click: { time: number; count: number; row: number; view?: ScrollView; start: number; end: number } | undefined;
	#selectionDown = false;
	#dragged = false;
	#url: string | undefined;
	#pointer: { x: number; y: number } | undefined;
	#direction: -1 | 0 | 1 = 0;
	#selectionTimer: ReturnType<typeof setInterval> | undefined;
	#barDrag: { view: ScrollView; offset: number } | undefined;
	#barHover: ScrollView | undefined;
	#indicator: { row: number; column: number; width: number } | undefined;
	#search: Search | undefined;
	#capture: TuiMouseDispatchTarget | undefined;
	#press: TuiMouseDispatchTarget | undefined;
	#pressPoint: { x: number; y: number } | undefined;
	#moved = false;
	#componentClick: { time: number; count: number; component: Component; x: number; y: number } | undefined;
	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.#options = { ...options };
		this.#copyOnSelect = options.copyOnSelect ?? true;
		this.#document = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.#scroll = new ScrollView(this.#document, { follow: "end", primary: true });
		this.#flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.#wheel = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.addInputListener((data) => this.input(data));
	}
	private primary(): ScrollView {
		return this.#layout?.primaryScrollView ?? this.#scroll;
	}
	get viewportTop(): number {
		return this.primary().scrollTop;
	}
	get isFollowingOutput(): boolean {
		return this.primary().isFollowingEnd;
	}
	setWheelScrollLines(lines: WheelScrollLines): void {
		this.#wheel.setLines(lines);
	}
	getCopyOnSelect(): boolean {
		return this.#copyOnSelect;
	}
	setCopyOnSelect(enabled: boolean): void {
		this.#copyOnSelect = enabled;
	}
	hasActiveSelection(): boolean {
		return this.selectionText() !== undefined;
	}
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.selectionText();
		return text ? this.copyText(text) : false;
	}
	resetTextSelection(): void {
		this.clearSelection();
		this.#click = undefined;
	}
	getScreenLines(): string[] {
		return [...this.#screen];
	}
	setLayoutRoot(component: Component | undefined): void {
		if (component === this.#root) return;
		this.#root = component;
		this.#layout = undefined;
		this.requestRender();
	}
	override render(width: number): string[] {
		return this.#root?.render(width) ?? super.render(width);
	}
	protected override getMountedRoots(): readonly Component[] {
		return this.#root ? [this.#root] : this.children;
	}
	protected override resetRenderState(): void {
		this.#screen = [];
		this.#width = 0;
		this.#height = 0;
		this.#layout = undefined;
	}
	protected override beforeTerminalStart(): void {
		this.clearSelection();
		this.hover(undefined);
		this.#barDrag = undefined;
		this.#flashes.dispose();
		this.#active = true;
		const capabilities = getCapabilities();
		this.#protocol = capabilities.images;
		this.#images.clear();
		if (capabilities.images === "iterm2") {
			this.#saved = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.#click = undefined;
		this.clearGesture();
		this.#componentClick = undefined;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		const multiplexer =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen");
		const mouse = "\x1b[?1000h\x1b[?1002h" + (multiplexer ? "" : "\x1b[?1003h") + "\x1b[?1004h\x1b[?1006h";
		this.terminal.write(ENTER + NOWRAP + ((this.#options.mouse ?? true) ? mouse : "") + "\x1b[2J\x1b[H\x1b[?25l");
	}
	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.closeSearch();
		this.stopAutoScroll();
		this.#selectionDown = false;
		this.hover(undefined);
		this.#barDrag = undefined;
		this.clearGesture();
		this.#flashes.dispose();
		if (this.#active)
			this.terminal.write(BEGIN + this.deleteImages() + ((this.#options.mouse ?? true) ? MOUSE_OFF : "") + WRAP + END);
		this.#images.clear();
	}
	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.#active) return;
		this.#active = false;
		if (options.preserveScreen) this.terminal.write(BEGIN + EXIT + "\x1b[?25h" + END);
		else {
			const width = Math.max(1, this.terminal.columns);
			const lines = this.applyLineResets(
				this.resolveFakeCursors(this.render(width)).map((line) => line.replace(ZONE, "").replaceAll(CURSOR_MARKER, "")),
			).map((line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)));
			this.terminal.write(
				BEGIN +
					EXIT +
					NOWRAP +
					lines.map((line) => "\r\x1b[2K" + line).join("\r\n") +
					"\x1b[0m" +
					WRAP +
					"\r\n\x1b[?25h" +
					END,
			);
		}
		if (this.#saved) {
			setCapabilities(this.#saved);
			this.#saved = undefined;
		}
	}
	private deleteImages(): string {
		return this.#protocol === "kitty" ? deleteAllKittyImages() : "";
	}
	scrollBy(lines: number): void {
		this.primary().scrollBy(lines);
		this.requestRender();
	}
	scrollToTop(): void {
		this.primary().scrollToStart();
		this.requestRender();
	}
	scrollToBottom(): void {
		this.primary().scrollToEnd();
		this.requestRender();
	}
	flash(message: string, durationMs?: number): void {
		this.#flashes.flash(message, durationMs);
	}
	private prompt(direction: -1 | 1): void {
		if (!this.#layout) return;
		const view = this.primary(),
			lines = getScrollViewBox(this.#layout, view)?.scrollContentLines;
		if (!lines) return;
		for (let row = view.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (PROMPT.test(lines[row] ?? "")) {
				view.scrollTo(row);
				this.requestRender();
				return;
			}
		}
	}
	private toggleSearch(): void {
		if (this.#search) {
			this.closeSearch();
			return;
		}
		const component = new AltScreenSearchComponent((query) => {
			const search = this.#search;
			if (!search || query === search.query) return;
			search.anchor = search.matches[search.selected]?.segments[0]?.row ?? this.primary().scrollTop;
			search.query = query;
			search.mode = "query";
			component.setResult(-1, 0);
			this.requestRender();
		}, this.#options.searchNavigationButtonStyle);
		const search: Search = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selected: -1,
			anchor: this.primary().scrollTop,
			mode: "query",
		};
		this.#search = search;
		search.overlay = this.showOverlay(component, { anchor: "top-right", width: "40%", minWidth: 32, margin: 1 });
	}
	private closeSearch(): void {
		const search = this.#search;
		if (!search) return;
		this.#search = undefined;
		search.overlay?.hide();
		this.requestRender();
	}
	private navigateSearch(direction: -1 | 1): void {
		if (!this.#search?.query) return;
		this.#search.mode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}
	private searchDirection(x: number, y: number): -1 | 1 | undefined {
		const search = this.#search,
			bounds = search?.overlay?.getBounds();
		if (
			!search ||
			!bounds ||
			x < bounds.col ||
			x >= bounds.col + bounds.width ||
			y < bounds.row ||
			y >= bounds.row + bounds.height
		)
			return;
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}
	private refreshSearch(layout: LayoutFrame): boolean {
		const search = this.#search;
		if (!search) return false;
		const view = layout.primaryScrollView ?? this.#scroll,
			box = getScrollViewBox(layout, view),
			lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selected = -1;
			search.key = undefined;
			search.mode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}
		const reveal = search.mode !== "retain",
			result = search.index.search(lines, search.query),
			matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.mode === "retain") return false;
		const exact = result.changed
			? search.key
				? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.key)
				: -1
			: search.selected;
		let selected = -1;
		if (matches.length) {
			if (search.mode === "query") {
				let start = 0,
					end = matches.length;
				while (start < end) {
					const pivot = start + Math.floor((end - start) / 2);
					if ((matches[pivot]!.segments[0]?.row ?? 0) >= search.anchor) end = pivot;
					else start = pivot + 1;
				}
				selected = start === matches.length ? 0 : start;
			} else if (search.mode === "next" || search.mode === "previous") {
				const base = exact >= 0 ? exact : Math.min(search.selected, matches.length - 1);
				selected =
					base < 0
						? search.mode === "next"
							? 0
							: matches.length - 1
						: (base + (search.mode === "next" ? 1 : matches.length - 1)) % matches.length;
			} else selected = exact >= 0 ? exact : Math.min(Math.max(0, search.selected), matches.length - 1);
		}
		search.selected = selected;
		search.key = selected >= 0 ? getAltScreenSearchMatchKey(matches[selected]!) : undefined;
		search.mode = "retain";
		search.component.setResult(selected, matches.length);
		if (!reveal) return false;
		const first = matches[selected]?.segments[0],
			last = matches[selected]?.segments.at(-1),
			before = view.scrollTop;
		if (!box || !first || !last || view.viewportHeight <= 0) return false;
		view.scrollTo(
			first.row < before || last.row > before + view.viewportHeight - 1
				? first.row - Math.floor(view.viewportHeight / 3)
				: before,
			{ disableFollow: true },
		);
		return view.scrollTop !== before;
	}
	private input(data: string): { consume?: boolean } | undefined {
		if (data === "\x1b[O") {
			const down = this.#selectionDown,
				nonempty = down && this.bounds() !== undefined;
			this.#selectionDown = false;
			this.stopAutoScroll();
			this.hover(undefined);
			if (this.#search?.component.setHoveredNavigationDirection(undefined)) this.requestRender();
			this.#barDrag = undefined;
			this.#url = undefined;
			this.#dragged = false;
			this.clearGesture();
			this.#componentClick = undefined;
			if (down) {
				this.#anchor = undefined;
				this.#focus = undefined;
				this.#initial = undefined;
				this.#granularity = "character";
				if (nonempty) this.requestRender();
			}
			this.#click = undefined;
			return { consume: true };
		}
		if (data === "\x1b[I") return { consume: true };
		const raw = this.parseMouse(data);
		if (raw) {
			const bit = raw.button & 3;
			if ((raw.button & 64) !== 0 && (bit === 0 || bit === 1)) this.wheel(raw, bit === 0 ? -1 : 1);
			else this.mouse(raw);
			return { consume: true };
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32,
				bit = button & 3;
			if ((button & 64) !== 0 && (bit === 0 || bit === 1))
				this.wheel(
					{ button, x: data.charCodeAt(4) - 33, y: data.charCodeAt(5) - 33, release: false },
					bit === 0 ? -1 : 1,
				);
			return { consume: true };
		}
		const keys = getKeybindings(),
			released = isKeyRelease(data),
			consume = (action: () => void) => {
				if (!released) action();
				return { consume: true };
			};
		if (keys.matches(data, "tui.altScreen.search")) return consume(() => this.toggleSearch());
		if (this.#search?.overlay?.isFocused()) {
			if (keys.matches(data, "tui.altScreen.searchNext")) return consume(() => this.navigateSearch(1));
			if (keys.matches(data, "tui.altScreen.searchPrevious")) return consume(() => this.navigateSearch(-1));
			if (keys.matches(data, "tui.altScreen.searchClose")) return consume(() => this.closeSearch());
		}
		if (this.isOverlayFocused() && this.#search?.overlay?.isFocused() !== true) return;
		const page = Math.max(1, this.primary().viewportHeight - 4),
			half = Math.max(1, Math.floor(this.primary().viewportHeight / 2));
		const actions = {
			"tui.altScreen.pageUp": () => this.scrollBy(-page),
			"tui.altScreen.pageDown": () => this.scrollBy(page),
			"tui.altScreen.halfPageUp": () => this.scrollBy(-half),
			"tui.altScreen.halfPageDown": () => this.scrollBy(half),
			"tui.altScreen.lineUp": () => this.scrollBy(-1),
			"tui.altScreen.lineDown": () => this.scrollBy(1),
			"tui.altScreen.previousPrompt": () => this.prompt(-1),
			"tui.altScreen.nextPrompt": () => this.prompt(1),
			"tui.altScreen.top": () => this.scrollToTop(),
			"tui.altScreen.bottom": () => this.scrollToBottom(),
		};
		for (const key of Object.keys(actions) as (keyof typeof actions)[])
			if (keys.matches(data, key)) return consume(actions[key]);
		return;
	}
	private parseMouse(data: string): Mouse | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		return match
			? { button: Number(match[1]), x: Number(match[2]) - 1, y: Number(match[3]) - 1, release: match[4] === "m" }
			: undefined;
	}
	private event(
		type: TuiMouseEvent["type"],
		raw: Mouse,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		const buttons = ["left", "middle", "right", "none"] as const;
		return {
			type,
			button: type === "wheel" ? "none" : buttons[raw.button & 3]!,
			x: raw.x,
			y: raw.y,
			screenX: raw.x,
			screenY: raw.y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (raw.button & 4) !== 0,
			alt: (raw.button & 8) !== 0,
			ctrl: (raw.button & 16) !== 0,
			...extra,
		};
	}
	private dispatch(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.#layout) return;
		const visited = new Set<Component>();
		for (const box of getLayoutBoxesAt(this.#layout, event.screenX, event.screenY)) {
			if (
				visited.has(box.component) ||
				(getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse)
			)
				continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return;
	}
	private apply(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const target = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component),
			changed = result.focus === true && this.getFocusedComponent() !== target;
		if (result.focus) this.setFocus(target);
		if (result.capture) this.#capture = result.target;
		return result.render ?? (changed || ["press", "click", "drag", "wheel"].includes(event.type));
	}
	private wheel(raw: Mouse, direction: -1 | 1): void {
		const delta = direction * this.#wheel.next(direction, performance.now()) * ((raw.button & 8) !== 0 ? 5 : 1),
			event = this.event("wheel", raw, { wheelDelta: delta });
		const overlay = this.dispatchMouseToOverlay(event),
			result = overlay.result ?? (overlay.hit ? undefined : this.dispatch(event));
		if (result) {
			if (this.apply(event, result)) this.requestRender();
			return;
		}
		let remaining = delta;
		const seen = new Set<ScrollView>();
		for (const view of this.#layout ? getScrollViewsAt(this.#layout, raw.x, raw.y) : []) {
			seen.add(view);
			remaining = view.scrollBy(remaining);
			if (!remaining || view.overscroll === "contain") break;
		}
		if (remaining && !seen.has(this.primary())) this.primary().scrollBy(remaining);
		this.updateHover(raw.x, raw.y);
		this.requestRender();
	}
	private clearGesture(): void {
		this.#capture = undefined;
		this.#press = undefined;
		this.#pressPoint = undefined;
		this.#moved = false;
	}
	private mouse(raw: Mouse): void {
		const motion = (raw.button & 32) !== 0,
			type: TuiMouseEvent["type"] = raw.release
				? "release"
				: motion
					? (raw.button & 3) === 3
						? "move"
						: "drag"
					: "press",
			event = this.event(type, raw);
		const target = this.#capture ?? this.#press;
		if (target) {
			if (this.#pressPoint && (raw.x !== this.#pressPoint.x || raw.y !== this.#pressPoint.y)) {
				this.#moved = true;
				this.#componentClick = undefined;
			}
			const result = dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
			let redraw = result ? this.apply(event, result) : false;
			if (raw.release) {
				if (!this.#moved && this.#pressPoint?.x === raw.x && this.#pressPoint.y === raw.y) {
					const previous = this.#componentClick,
						time = Date.now(),
						count =
							previous &&
							time - previous.time <= 500 &&
							previous.component === target.component &&
							previous.x === raw.x &&
							previous.y === raw.y
								? (previous.count % 3) + 1
								: 1;
					this.#componentClick = { time, count, component: target.component, x: raw.x, y: raw.y };
					const click = this.event("click", raw, { clickCount: count });
					const clicked = dispatchMouseEvent(target.component, retargetMouseEvent(click, target));
					if (clicked) redraw = this.apply(click, clicked) || redraw;
				}
				this.clearGesture();
			}
			if (redraw) this.requestRender();
			return;
		}
		const direction = this.searchDirection(raw.x, raw.y);
		if (this.#search?.component.setHoveredNavigationDirection(direction)) this.requestRender();
		if (direction !== undefined && !raw.release && !motion && (raw.button & 3) === 0) {
			this.navigateSearch(direction);
			return;
		}
		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			const indicator = this.#indicator;
			if (
				indicator &&
				!raw.release &&
				!motion &&
				(raw.button & 3) === 0 &&
				raw.y === indicator.row &&
				raw.x >= indicator.column &&
				raw.x < indicator.column + indicator.width
			) {
				this.scrollToBottom();
				return;
			}
			const handled = this.scrollbarMouse(raw);
			if (!this.#barDrag) this.updateHover(raw.x, raw.y);
			if (handled) return;
		} else this.hover(undefined);
		const result = overlay.result ?? (overlay.hit ? undefined : this.dispatch(event));
		if (result) {
			const redraw = this.apply(event, result);
			if (type === "press") {
				this.clearSelection();
				this.#press = result.target;
				this.#pressPoint = { x: raw.x, y: raw.y };
				this.#moved = false;
			}
			if (redraw) this.requestRender();
			return;
		}
		if (
			this.#options.onRightClickPaste &&
			process.platform === "win32" &&
			process.env.TERM_PROGRAM?.toLowerCase() !== "vscode" &&
			!raw.release &&
			raw.button === 2
		) {
			try {
				this.#options.onRightClickPaste.call(this);
			} catch {}
			return;
		}
		this.selectMouse(raw);
	}
	private scrollbarTarget(
		x: number,
		y: number,
		hidden = false,
	): { view: ScrollView; geometry: ScrollbarGeometry } | undefined {
		if (this.hasOverlay() || !this.#layout) return;
		for (const view of getScrollViewsAt(this.#layout, x, y)) {
			const box = getScrollViewBox(this.#layout, view),
				geometry = box ? getScrollbarGeometry(box, hidden) : undefined;
			if (geometry && x === geometry.column && y >= geometry.trackTop && y < geometry.trackTop + geometry.trackHeight)
				return { view, geometry };
		}
		return;
	}
	private hover(view: ScrollView | undefined): void {
		if (view === this.#barHover) return;
		this.#barHover?.setScrollbarActive(false);
		this.#barHover = view;
		view?.setScrollbarActive(true);
	}
	private updateHover(x: number, y: number): void {
		this.hover(this.scrollbarTarget(x, y, true)?.view);
	}
	private moveBar(view: ScrollView, geometry: ScrollbarGeometry, y: number, grab: number): void {
		const travel = geometry.trackHeight - geometry.thumbHeight,
			offset = Math.max(0, Math.min(travel, y - geometry.trackTop - grab));
		view.scrollTo(travel === 0 ? 0 : Math.round((offset / travel) * geometry.maxScrollTop));
	}
	private scrollbarMouse(raw: Mouse): boolean {
		if (this.#barDrag) {
			if (raw.release) {
				this.#barDrag = undefined;
				return true;
			}
			const box = this.#layout ? getScrollViewBox(this.#layout, this.#barDrag.view) : undefined,
				geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) this.moveBar(this.#barDrag.view, geometry, raw.y, this.#barDrag.offset);
			return true;
		}
		if (raw.release || (raw.button & 32) !== 0 || (raw.button & 3) !== 0) return false;
		const target = this.scrollbarTarget(raw.x, raw.y);
		if (!target) return false;
		this.clearSelection();
		this.#click = undefined;
		this.hover(target.view);
		const onThumb = raw.y >= target.geometry.thumbTop && raw.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const offset = onThumb ? raw.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.moveBar(target.view, target.geometry, raw.y, offset);
		this.#barDrag = { view: target.view, offset };
		return true;
	}
	private clearSelection(): void {
		this.stopAutoScroll();
		this.#selectionDown = false;
		this.#anchor = undefined;
		this.#focus = undefined;
		this.#initial = undefined;
		this.#granularity = "character";
		this.#url = undefined;
		this.#dragged = false;
	}
	private scrollPoint(view: ScrollView, x: number, y: number): Point | undefined {
		const box = this.#layout ? getScrollViewBox(this.#layout, view) : undefined;
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return;
		const top = Math.max(0, box.rect.y, box.clip.y),
			bottom = Math.min(this.terminal.rows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
		if (bottom < top) return;
		return {
			row: Math.max(
				0,
				Math.min(
					Math.max(0, (box.scrollContentLines?.length ?? 1) - 1),
					view.scrollTop + Math.max(top, Math.min(bottom, y)) - box.rect.y,
				),
			),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView: view,
		};
	}
	private point(raw: Mouse, view?: ScrollView): Point {
		return (
			(view ? this.scrollPoint(view, raw.x, raw.y) : undefined) ?? {
				row: Math.max(0, Math.min(this.terminal.rows - 1, raw.y)),
				col: Math.max(0, Math.min(this.terminal.columns - 1, raw.x)),
			}
		);
	}
	private source(point: Point): string {
		return point.scrollView && this.#layout
			? (getScrollViewBox(this.#layout, point.scrollView)?.scrollContentLines?.[point.row] ?? "")
			: (this.#screen[point.row] ?? "");
	}
	private word(point: Point): Range | undefined {
		const segments: { start: number; end: number; selectable: boolean; joiner: boolean }[] = [];
		let col = 0;
		for (const part of words.segment(stripTerminalSequences(this.source(point)))) {
			const end = col + visibleWidth(part.segment),
				joiner = part.segment === "/" || part.segment === "-";
			segments.push({ start: col, end, selectable: part.isWordLike === true || joiner, joiner });
			col = end;
		}
		const clicked = segments.findIndex((part) => point.col >= part.start && point.col < part.end);
		if (clicked < 0) return;
		const joins = (left: number, right: number) =>
			segments[left]!.selectable && segments[right]!.selectable && (segments[left]!.joiner || segments[right]!.joiner);
		let first = clicked,
			last = clicked;
		while (first > 0 && joins(first - 1, first)) first--;
		while (last + 1 < segments.length && joins(last, last + 1)) last++;
		return {
			start: { ...point, col: segments[first]!.start },
			end: { ...point, col: segments[last]!.end, boundary: true },
		};
	}
	private line(point: Point): Range {
		return { start: { ...point, col: 0 }, end: { ...point, col: visibleWidth(this.source(point)), boundary: true } };
	}
	private moveSelection(point: Point): void {
		if (this.#granularity === "character" || !this.#initial) {
			this.#focus = point;
			return;
		}
		const range = this.#granularity === "word" ? this.word(point) : this.line(point);
		if (!range) return;
		const initial = this.#initial,
			before =
				range.start.row < initial.start.row ||
				(range.start.row === initial.start.row && range.start.col < initial.start.col);
		this.#anchor = before ? initial.end : initial.start;
		this.#focus = before ? range.start : range.end;
	}
	private stopAutoScroll(): void {
		if (this.#selectionTimer !== undefined) clearInterval(this.#selectionTimer);
		this.#selectionTimer = undefined;
		this.#direction = 0;
		this.#pointer = undefined;
	}
	private autoScroll(raw: Mouse): void {
		const view = this.#anchor?.scrollView,
			box = view && this.#layout ? getScrollViewBox(this.#layout, view) : undefined;
		if (!view || !box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopAutoScroll();
			return;
		}
		const top = Math.max(0, box.rect.y, box.clip.y),
			bottom = Math.min(this.terminal.rows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
		this.#pointer = { x: raw.x, y: raw.y };
		this.#direction = raw.y <= top ? -1 : raw.y >= bottom ? 1 : 0;
		if (!this.#direction) {
			this.stopAutoScroll();
			return;
		}
		if (this.#selectionTimer) return;
		this.#selectionTimer = setInterval(() => {
			const current = this.#anchor?.scrollView,
				pointer = this.#pointer,
				direction = this.#direction;
			if (!current || !pointer || !direction || current.scrollBy(direction) === direction) {
				this.stopAutoScroll();
				return;
			}
			const point = this.scrollPoint(current, pointer.x, pointer.y);
			if (point) this.moveSelection(point);
			this.requestRender();
		}, 50);
		this.#selectionTimer.unref();
	}
	private selectMouse(raw: Mouse): void {
		const button = raw.button & 3;
		if (button !== 0 && !(raw.release && button === 3)) return;
		const point = this.point(raw, this.#anchor?.scrollView);
		if (raw.release) {
			if (!this.#selectionDown) return;
			this.#selectionDown = false;
			this.stopAutoScroll();
			if (!this.#anchor) return;
			this.moveSelection(point);
			const click =
					!this.#dragged &&
					this.#anchor.scrollView === point.scrollView &&
					this.#anchor.row === point.row &&
					this.#anchor.col === point.col,
				url = click ? this.#url : undefined;
			this.#url = undefined;
			if (url && this.#options.openUrl) {
				this.#anchor = undefined;
				this.#focus = undefined;
				try {
					this.#options.openUrl.call(this, url);
				} catch {}
				this.requestRender();
				return;
			}
			if (click) {
				const event = this.event("click", raw, { clickCount: this.#click?.count ?? 1 }),
					overlay = this.dispatchMouseToOverlay(event),
					result = overlay.result ?? (overlay.hit ? undefined : this.dispatch(event));
				if (result) {
					const redraw = this.apply(event, result);
					this.clearSelection();
					if (redraw) this.requestRender();
					return;
				}
			}
			if (this.#copyOnSelect) void this.copyActiveSelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((raw.button & 32) !== 0) {
			if (!this.#selectionDown || !this.#anchor) return;
			this.#dragged = true;
			this.#click = undefined;
			this.#url = undefined;
			this.moveSelection(point);
			this.autoScroll(raw);
			this.requestRender();
			return;
		}
		this.stopAutoScroll();
		this.#selectionDown = true;
		const view = !this.hasOverlay() && this.#layout ? getScrollViewsAt(this.#layout, raw.x, raw.y)[0] : undefined,
			anchor = this.point(raw, view),
			word = this.word(anchor),
			previous = this.#click,
			time = Date.now();
		const count =
			word &&
			previous &&
			time - previous.time <= 500 &&
			previous.row === anchor.row &&
			previous.view === anchor.scrollView &&
			previous.start === word.start.col &&
			previous.end === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.#click = word
			? { time, count, row: anchor.row, view: anchor.scrollView, start: word.start.col, end: word.end.col }
			: undefined;
		const range = count === 2 ? word : count === 3 ? this.line(anchor) : undefined;
		this.#granularity = range ? (count === 2 ? "word" : "line") : "character";
		this.#initial = range;
		this.#anchor = range?.start ?? anchor;
		this.#focus = range?.end ?? anchor;
		this.#dragged = false;
		this.#url = range
			? undefined
			: getOsc8LinkAtColumn(
					this.#screen[Math.max(0, Math.min(this.terminal.rows - 1, raw.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, raw.x)),
				);
		this.requestRender();
	}
	private bounds(): Range | undefined {
		const a = this.#anchor,
			b = this.#focus;
		if (!a || !b || a.scrollView !== b.scrollView || (a.row === b.row && a.col === b.col)) return;
		return a.row < b.row || (a.row === b.row && a.col < b.col) ? { start: a, end: b } : { start: b, end: a };
	}
	private columns(
		line: string,
		row: number,
		selection: Range,
		min = 0,
		max = visibleWidth(line),
	): { start: number; end: number } {
		const width = visibleWidth(line);
		let start = Math.max(0, min),
			end = Math.min(width, max);
		if (row === selection.start.row)
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, width);
		if (row === selection.end.row)
			end = selection.end.boundary
				? Math.min(selection.end.col, width)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, width));
		return { start: Math.max(min, start), end: Math.min(max, end) };
	}
	private selectionText(): string | undefined {
		const selection = this.bounds();
		if (!selection) return;
		let source: readonly string[] = this.#screen;
		if (selection.start.scrollView) {
			const box = this.#layout ? getScrollViewBox(this.#layout, selection.start.scrollView) : undefined;
			if (!box?.scrollContentLines) return;
			source = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = source[row] ?? "",
				columns = this.columns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		return lines.join("\n") || undefined;
	}
	private async copyText(text: string): Promise<boolean> {
		if (this.#options.copySelection) {
			const result = await this.#options.copySelection.call(this, text),
				ok = result === true;
			this.flash(ok ? "Copied!" : typeof result === "string" ? result : "Copy failed", ok ? undefined : 5000);
			return ok;
		}
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
		return true;
	}
	private styleRuns(text: string, style: (text: string) => string): string {
		let result = "",
			plain = 0,
			offset = 0;
		while (offset < text.length) {
			const code = extractAnsiCode(text, offset);
			if (!code) {
				offset++;
				continue;
			}
			if (offset > plain) result += style(text.slice(plain, offset));
			result += code.code;
			offset += code.length;
			plain = offset;
		}
		return result + (plain < text.length ? style(text.slice(plain)) : "");
	}
	private highlightSearch(screen: string[], layout: LayoutFrame): string[] {
		const search = this.#search;
		if (!search || search.selected < 0 || !search.matches.length) return screen;
		const view = layout.primaryScrollView ?? this.#scroll,
			box = getScrollViewBox(layout, view);
		if (!box) return screen;
		const minRow = Math.max(0, box.rect.y, box.clip.y),
			maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height),
			minCol = Math.max(0, box.rect.x, box.clip.x);
		const maxCol = Math.min(
			this.terminal.columns,
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			getScrollbarGeometry(box)?.column ?? Infinity,
		);
		const ranges = new Map<number, { start: number; end: number; current: boolean }[]>();
		const firstContentRow = view.scrollTop + minRow - box.rect.y;
		const lastContentRow = view.scrollTop + maxRow - box.rect.y - 1;
		let start = 0,
			end = search.matches.length;
		while (start < end) {
			const pivot = start + Math.floor((end - start) / 2);
			if ((search.matches[pivot]!.segments.at(-1)?.row ?? -1) >= firstContentRow) end = pivot;
			else start = pivot + 1;
		}
		for (let index = start; index < search.matches.length; index++) {
			const match = search.matches[index]!;
			if ((match.segments[0]?.row ?? 0) > lastContentRow) break;
			for (const segment of match.segments) {
				const row = box.rect.y + segment.row - view.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const start = Math.max(minCol, box.rect.x + segment.startCol),
					end = Math.min(maxCol, box.rect.x + segment.endCol);
				if (end <= start) continue;
				const list = ranges.get(row) ?? [];
				list.push({ start, end, current: index === search.selected });
				ranges.set(row, list);
			}
		}
		const result = [...screen];
		for (const [row, list] of ranges) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const width = visibleWidth(line);
			for (const range of list.sort((a, b) => b.start - a.start)) {
				const start = Math.min(range.start, width),
					end = Math.min(range.end, width);
				if (end <= start) continue;
				const style = range.current
					? (this.#options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`))
					: (this.#options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`));
				line =
					sliceByColumn(line, 0, start, true) +
					this.styleRuns(sliceByColumn(line, start, end - start, true), style) +
					sliceByColumn(line, end, Math.max(0, width - end), true);
			}
			result[row] = line;
		}
		return result;
	}
	private invert(text: string): string {
		let result = "\x1b[7m",
			index = 0;
		while (index < text.length) {
			const code = extractAnsiCode(text, index);
			if (code) {
				result += code.code + (code.code.endsWith("m") ? "\x1b[7m" : "");
				index += code.length;
			} else result += text[index++];
		}
		return result + "\x1b[27m";
	}
	private highlightSelection(screen: string[], layout: LayoutFrame): string[] {
		let selection = this.bounds();
		if (!selection) return screen;
		let minRow = 0,
			maxRow = screen.length - 1,
			minCol = 0,
			maxCol = this.terminal.columns;
		const view = selection.start.scrollView;
		if (view) {
			const box = getScrollViewBox(layout, view);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minCol = Math.max(0, box.rect.x, box.clip.x);
			maxCol = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			selection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - view.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - view.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		const range = selection;
		return screen.map((line, row) => {
			if (row < minRow || row > maxRow || row < range.start.row || row > range.end.row || isImageLine(line))
				return line;
			const { start, end } = this.columns(line, row, range, minCol, maxCol),
				width = visibleWidth(line);
			if (end <= start) return line;
			return (
				sliceByColumn(line, 0, start, true) +
				this.invert(sliceByColumn(line, start, end - start, true)) +
				sliceByColumn(line, end, Math.max(0, width - end), true)
			);
		});
	}
	private indicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		this.#indicator = undefined;
		const view = layout.primaryScrollView ?? this.#scroll;
		if (!this.#options.scrollToEndIndicator || !view.followEnd || view.isFollowingEnd) return screen;
		const box = getScrollViewBox(layout, view),
			clip = box?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const label = truncateToWidth(this.#options.scrollToEndIndicator.call(this), clip.width, ""),
			col = clip.x + Math.floor((clip.width - visibleWidth(label)) / 2);
		const right = box ? getScrollbarGeometry(box)?.column : undefined,
			text = truncateToWidth(label, Math.max(0, (right ?? clip.x + clip.width) - col), ""),
			size = visibleWidth(text);
		if (!size) return screen;
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, col, size, width);
		this.#indicator = { row, column: col, width: size };
		return result;
	}
	private prepareImages(screen: string[]): { lines: string[]; deletions: string } {
		const visible = new Set<number>(),
			lines = screen.map((line) => {
				const placement = getKittyImagePlacement(line);
				if (!placement) return line;
				visible.add(placement.imageId);
				const previous = this.#images.get(placement.imageId);
				this.#images.delete(placement.imageId);
				this.#images.set(placement.imageId, {
					transmissionGeneration: placement.transmissionGeneration,
					transmissionBytes: placement.transmissionBytes,
					estimatedDecodedBytes: placement.estimatedDecodedBytes,
				});
				return previous?.transmissionGeneration === placement.transmissionGeneration ? placement.replacementLine : line;
			});
		let count = 0,
			bytes = 0,
			decoded = 0,
			deletions = "";
		for (const [id, image] of this.#images)
			if (!visible.has(id)) {
				count++;
				bytes += image.transmissionBytes;
				decoded += image.estimatedDecodedBytes;
			}
		for (const [id, image] of this.#images) {
			if (count <= 16 && bytes <= 32 * 1024 * 1024 && decoded <= 64 * 1024 * 1024) break;
			if (visible.has(id)) continue;
			deletions += deleteKittyImage(id);
			this.#images.delete(id);
			count--;
			bytes -= image.transmissionBytes;
			decoded -= image.estimatedDecodedBytes;
		}
		return { lines, deletions };
	}
	protected override doRender(): void {
		if (this.stopped || !this.#active) return;
		const width = Math.max(1, this.terminal.columns),
			height = Math.max(1, this.terminal.rows),
			root = this.#root ?? this.#scroll;
		let layout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.refreshSearch(layout)) layout = renderLayoutFrame(root, width, height, () => this.requestRender());
		let screen = this.resolveFakeCursors(layout.lines.map((line) => line.replace(ZONE, "")));
		screen = this.highlightSearch(screen, layout);
		screen = this.indicator(screen, layout, width);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.highlightSelection(screen, layout);
		for (const [row, line] of this.#flashes.render(width).slice(-height).entries()) {
			const size = visibleWidth(line);
			if (size) screen[row] = compositeTuiLine(screen[row] ?? "", line, width - size, size, width);
		}
		const cursor = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) =>
			isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true),
		);
		const full = !this.#screen.length || this.#width !== width || this.#height !== height,
			changed = screen.map((line, row) => line !== this.#screen[row]);
		const anchorChanged = screen.some(
			(line, row) => changed[row] && (isImageLine(line) || isImageLine(this.#screen[row] ?? "")),
		);
		const wez = Boolean(process.env.WEZTERM_PANE) || process.env.TERM_PROGRAM?.toLowerCase() === "wezterm";
		const cellsChanged =
			!anchorChanged &&
			wez &&
			this.#protocol === "kitty" &&
			changed.some(Boolean) &&
			screen.some((line, row) => {
				const rows = getKittyImagePlacementRows(line);
				if (rows === undefined) return false;
				for (let index = row; index < row + rows; index++) if (changed[index]) return true;
				return false;
			});
		const images = anchorChanged || cellsChanged,
			redrawImages = full || images,
			hadImages = this.#images.size > 0;
		const prepared =
			redrawImages && this.#protocol === "kitty" ? this.prepareImages(screen) : { lines: screen, deletions: "" };
		let output = BEGIN;
		if (full) {
			this.fullRedrawCount++;
			output +=
				(this.#protocol === "kitty" && hadImages ? deleteAllKittyPlacements() : this.deleteImages()) + "\x1b[2J";
		} else if (images)
			output += this.#protocol === "iterm2" ? "\x1b[2J" : this.#protocol === "kitty" ? deleteAllKittyPlacements() : "";
		output += prepared.deletions;
		const rows = Array.from({ length: height }, (_, row) => row).filter(
			(row) => full || images || screen[row] !== this.#screen[row],
		);
		if (redrawImages && this.#protocol === "kitty" && screen.some(isImageLine) && wez) {
			for (const row of rows) output += `\x1b[${row + 1};1H\x1b[2K`;
			for (const image of [false, true])
				for (const row of rows)
					if (isImageLine(prepared.lines[row] ?? "") === image)
						output += `\x1b[${row + 1};1H${prepared.lines[row] ?? ""}`;
		} else for (const row of rows) output += `\x1b[${row + 1};1H\x1b[2K${prepared.lines[row] ?? ""}`;
		output += cursor
			? `\x1b[${cursor.row + 1};${Math.min(width, cursor.col) + 1}H${this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l"}`
			: "\x1b[?25l";
		this.terminal.write(output + END);
		this.#screen = screen;
		this.#width = width;
		this.#height = height;
		this.#layout = layout;
	}
}
