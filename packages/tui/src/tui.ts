import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColors,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	x: number;
	y: number;
	screenX: number;
	screenY: number;
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	wheelDelta?: number;
	clickCount?: number;
}
export interface TuiMouseEventResult {
	handled?: boolean;
	capture?: boolean;
	focus?: boolean;
	render?: boolean;
}
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	focusTarget?: Component;
}
export interface Component {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | TuiMouseDispatchResult | undefined;
	wantsKeyRelease?: boolean;
}
export interface Focusable {
	focused: boolean;
}
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}
export const CURSOR_MARKER = "\x1b_axi:c\x07";
export const FAKE_CURSOR_START = "\x1b_axi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_axi:/fc\x07";
export function renderFakeCursor(text: string): string {
	return FAKE_CURSOR_START + text + FAKE_CURSOR_END;
}
export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) return result.focus && component.handleInput ? { ...result, focusTarget: component } : result;
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export class Container implements Component {
	children: Component[] = [];
	#layout: { width: number; entries: { component: Component; height: number }[] } | undefined;
	addChild(component: Component): void {
		this.children.push(component);
	}
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index >= 0) this.children.splice(index, 1);
	}
	clear(): void {
		this.children = [];
	}
	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}
	render(width: number): string[] {
		const entries: { component: Component; height: number }[] = [];
		const output: string[] = [];
		for (const component of this.children) {
			const rendered = component.render(width);
			entries.push({ component, height: rendered.length });
			for (const line of rendered) output.push(line);
		}
		this.#layout = { width, entries };
		return output;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const entries =
			this.#layout?.width === event.width
				? this.#layout.entries
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let offset = 0;
		for (const { component, height } of entries) {
			if (event.y >= offset && event.y < offset + height) {
				const result = dispatchMouseEvent(component, { ...event, y: event.y - offset, height });
				return result?.focus && "handleInput" in this && typeof this.handleInput === "function"
					? { ...result, focusTarget: this }
					: result;
			}
			offset += height;
		}
		return undefined;
	}
}

export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}
export type SizeValue = number | `${number}%`;
export interface OverlayOptions {
	width?: SizeValue;
	minWidth?: number;
	maxHeight?: SizeValue;
	anchor?: OverlayAnchor;
	offsetX?: number;
	offsetY?: number;
	row?: SizeValue;
	col?: SizeValue;
	margin?: OverlayMargin | number;
	visible?: (termWidth: number, termHeight: number) => boolean;
	nonCapturing?: boolean;
}
export interface OverlayUnfocusOptions {
	target: Component | null;
}
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}
export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(options?: OverlayUnfocusOptions): void;
	isFocused(): boolean;
	getBounds(): OverlayBounds | undefined;
}
export type TuiMode = "regular" | "fullscreen";
export interface TuiStopOptions {
	preserveScreen?: boolean;
}
export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors>;
}
export const VIEWPORT_TUI = Symbol.for("@axi/tui/viewport");
export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}
export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return VIEWPORT_TUI in tui && tui[VIEWPORT_TUI] === true;
}

const lineReset = "\x1b[0m\x1b]8;;\x07";
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;
	const base = extractSegments(baseLine, startCol, startCol + overlayWidth, totalWidth - startCol - overlayWidth, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const afterTarget = Math.max(
		0,
		totalWidth - Math.max(startCol, base.beforeWidth) - Math.max(overlayWidth, overlay.width),
	);
	const line =
		base.before +
		" ".repeat(Math.max(0, startCol - base.beforeWidth)) +
		lineReset +
		overlay.text +
		" ".repeat(Math.max(0, overlayWidth - overlay.width)) +
		lineReset +
		base.after +
		" ".repeat(Math.max(0, afterTarget - base.afterWidth));
	return visibleWidth(line) <= totalWidth ? line : sliceByColumn(line, 0, totalWidth, true);
}

type Overlay = {
	component: Component;
	options?: OverlayOptions;
	previous: Component | null;
	hidden: boolean;
	order: number;
	bounds?: OverlayBounds;
};
type Restore =
	| { kind: "none" }
	| { kind: "eligible"; overlay: Overlay }
	| {
			kind: "blocked";
			overlay: Overlay;
			blocker: Component;
			resume: { kind: "overlay" } | { kind: "target"; target: Component | null };
	  };
type ColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: (RgbColor | undefined)[];
	replied: Set<string>;
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer?: ReturnType<typeof setTimeout>;
};
function size(value: SizeValue | undefined, available: number): number | undefined {
	return typeof value === "number"
		? value
		: value !== undefined && /^\d+(?:\.\d+)?%$/.test(value)
			? Math.floor((available * Number.parseFloat(value)) / 100)
			: undefined;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	terminal: Terminal;
	onDebug?: () => void;
	protected stopped = false;
	protected fullRedrawCount = 0;
	protected readonly logDirectory: string | undefined;
	#focused: Component | null = null;
	#hardware = false;
	#clearShrink = false;
	#listeners = new Set<TuiInputListener>();
	#schemes = new Set<(scheme: TerminalColorScheme) => void>();
	#notifications = false;
	#queries: ColorQuery[] = [];
	#overlays: Overlay[] = [];
	#drawnOverlays: { entry: Overlay; bounds: OverlayBounds }[] = [];
	#order = 0;
	#restore: Restore = { kind: "none" };
	#requested = false;
	#immediate = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#lastRender = 0;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.#hardware = showHardwareCursor ?? false;
		this.logDirectory = logDirectory;
	}
	protected abstract doRender(): void;
	protected resetRenderState(): void {}
	protected beforeTerminalStart(): void {}
	protected afterTerminalStart(): void {}
	protected beforeTerminalStop(_options: TuiStopOptions): void {}
	protected afterTerminalStop(_options: TuiStopOptions): void {}
	protected getExitRestorePrefix(): string {
		return (this.#notifications ? "\x1b[?2031l" : "") + "\x1b[?25h";
	}
	protected getExitRestoreSuffix(): string {
		return "";
	}
	readonly #exitRestore = () => {
		if (this.stopped) return;
		try {
			this.terminal.restoreOnExit?.(this.getExitRestorePrefix(), this.getExitRestoreSuffix());
		} catch {}
	};
	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}
	get fullRedraws(): number {
		return this.fullRedrawCount;
	}
	get hasOverlayEntries(): boolean {
		return this.#overlays.length > 0;
	}
	getShowHardwareCursor(): boolean {
		return this.#hardware;
	}
	setShowHardwareCursor(enabled: boolean): void {
		if (this.#hardware === enabled) return;
		this.#hardware = enabled;
		if (!enabled) this.#hideCursor();
		this.requestRender();
	}
	getClearOnShrink(): boolean {
		return this.#clearShrink;
	}
	setClearOnShrink(enabled: boolean): void {
		this.#clearShrink = enabled;
	}
	getFocusedComponent(): Component | null {
		return this.#focused;
	}
	#visible(entry: Overlay): boolean {
		return !entry.hidden && (entry.options?.visible?.(this.terminal.columns, this.terminal.rows) ?? true);
	}
	#front(): Overlay | undefined {
		return this.#overlays
			.filter((entry) => !entry.options?.nonCapturing && this.#visible(entry))
			.reduce<Overlay | undefined>((front, entry) => (!front || entry.order > front.order ? entry : front), undefined);
	}
	#hideCursor(): void {
		if (!this.stopped) this.terminal.hideCursor();
	}
	#contains(root: Component, target: Component): boolean {
		return (
			root === target || (root instanceof Container && root.children.some((child) => this.#contains(child, target)))
		);
	}
	#mounted(target: Component): boolean {
		return this.getMountedRoots().some((root) => this.#contains(root, target));
	}
	#activeRestore(): Restore {
		return this.#restore.kind !== "none" &&
			this.#overlays.includes(this.#restore.overlay) &&
			this.#visible(this.#restore.overlay)
			? this.#restore
			: { kind: "none" };
	}
	#resume(state: Extract<Restore, { kind: "blocked" }>): Component | null {
		if (state.resume.kind === "overlay") return state.overlay.component;
		this.#restore = { kind: "none" };
		return state.resume.target;
	}
	#ancestor(entry: Overlay, target: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.previous;
		while (current && !visited.has(current)) {
			if (current === target) return true;
			visited.add(current);
			const parent = this.#overlays.find((candidate) => candidate.component === current);
			current = parent?.previous ?? null;
		}
		return false;
	}
	setFocus(component: Component | null): void {
		this.#focus(component, false);
	}
	#focus(target: Component | null, preserve: boolean): void {
		const old = this.#focused,
			previousOverlay = this.#overlays.find((entry) => entry.component === old && this.#visible(entry)),
			restore = this.#activeRestore();
		if (target && !this.#overlays.some((entry) => entry.component === target)) {
			if (restore.kind === "blocked" && restore.blocker === old) {
				if (restore.resume.kind === "target" || !this.#mounted(restore.blocker)) target = this.#resume(restore);
				else this.#restore = { ...restore, blocker: target };
			} else if (
				previousOverlay &&
				restore.kind !== "none" &&
				restore.overlay === previousOverlay &&
				!this.#ancestor(previousOverlay, target)
			)
				this.#restore = { kind: "blocked", overlay: previousOverlay, blocker: target, resume: { kind: "overlay" } };
		} else if (!target) {
			if (restore.kind === "blocked" && restore.blocker === old) target = this.#resume(restore);
			else if (!preserve) this.#restore = { kind: "none" };
		}
		if (isFocusable(old)) old.focused = false;
		this.#focused = target;
		if (isFocusable(target)) target.focused = true;
		const overlay = this.#overlays.find((entry) => entry.component === target && this.#visible(entry));
		if (overlay) this.#restore = { kind: "eligible", overlay };
	}
	#clearRestore(entry: Overlay): void {
		if (this.#restore.kind !== "none" && this.#restore.overlay === entry) this.#restore = { kind: "none" };
	}
	#removeOverlay(entry: Overlay): void {
		const index = this.#overlays.indexOf(entry);
		if (index < 0) return;
		this.#clearRestore(entry);
		for (const other of this.#overlays)
			if (other !== entry && other.previous === entry.component) other.previous = entry.previous;
		this.#overlays.splice(index, 1);
		if (this.#focused === entry.component) this.setFocus(this.#front()?.component ?? entry.previous);
		if (!this.#overlays.length) this.#hideCursor();
		this.requestRender();
	}
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: Overlay = { component, options, previous: this.#focused, hidden: false, order: ++this.#order };
		this.#overlays.push(entry);
		if (!options?.nonCapturing && this.#visible(entry)) this.setFocus(component);
		this.#hideCursor();
		this.requestRender();
		return {
			hide: () => this.#removeOverlay(entry),
			isHidden: () => entry.hidden,
			setHidden: (hidden) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				if (hidden) {
					this.#clearRestore(entry);
					if (this.#focused === component) this.setFocus(this.#front()?.component ?? entry.previous);
				} else if (!options?.nonCapturing && this.#visible(entry)) {
					entry.order = ++this.#order;
					this.setFocus(component);
				}
				this.requestRender();
			},
			focus: () => {
				if (this.#overlays.includes(entry) && this.#visible(entry)) {
					entry.order = ++this.#order;
					this.setFocus(component);
					this.requestRender();
				}
			},
			unfocus: (unfocusOptions) => {
				const focused = this.#focused === component,
					restore = this.#restore;
				if (!focused && !(restore.kind !== "none" && restore.overlay === entry)) return;
				if (restore.kind === "blocked" && restore.overlay === entry && this.#focused === restore.blocker) {
					this.#restore = unfocusOptions
						? { ...restore, resume: { kind: "target", target: unfocusOptions.target } }
						: { kind: "none" };
				} else {
					this.#clearRestore(entry);
					const front = this.#front();
					if (focused || unfocusOptions)
						this.setFocus(
							unfocusOptions ? unfocusOptions.target : front && front !== entry ? front.component : entry.previous,
						);
				}
				this.requestRender();
			},
			isFocused: () => this.#focused === component,
			getBounds: () =>
				this.#overlays.includes(entry) && this.#visible(entry) && entry.bounds ? { ...entry.bounds } : undefined,
		};
	}
	hideOverlay(): void {
		const entry = this.#overlays.at(-1);
		if (entry) this.#removeOverlay(entry);
	}
	hasOverlay(): boolean {
		return this.#overlays.some((entry) => this.#visible(entry));
	}
	protected isOverlayFocused(): boolean {
		return this.#overlays.some((entry) => entry.component === this.#focused && this.#visible(entry));
	}
	protected resolveMouseFocusTarget(component: Component): Component {
		return (
			[...this.#overlays].reverse().find((entry) => this.#visible(entry) && this.#contains(entry.component, component))
				?.component ?? component
		);
	}
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (const { entry, bounds } of [...this.#drawnOverlays].reverse()) {
			if (
				event.screenX < bounds.col ||
				event.screenX >= bounds.col + bounds.width ||
				event.screenY < bounds.row ||
				event.screenY >= bounds.row + bounds.height
			)
				continue;
			const result = dispatchMouseEvent(entry.component, {
				...event,
				x: event.screenX - bounds.col,
				y: event.screenY - bounds.row,
				width: bounds.width,
				height: bounds.height,
			});
			return result
				? { hit: true, result: result.focus ? { ...result, focusTarget: entry.component } : result }
				: { hit: true };
		}
		return { hit: false };
	}
	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.#overlays) overlay.component.invalidate();
	}
	start(): void {
		this.stopped = false;
		process.off("exit", this.#exitRestore);
		process.on("exit", this.#exitRestore);
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.#input(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.#notifications) this.terminal.write("\x1b[?2031h");
		if (getCapabilities().images) this.terminal.write("\x1b[16t");
		this.requestRender();
	}
	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		process.off("exit", this.#exitRestore);
		this.#cancelTimer();
		if (this.#notifications) this.terminal.write("\x1b[?2031l");
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop(options);
	}
	addInputListener(listener: TuiInputListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	removeInputListener(listener: TuiInputListener): void {
		this.#listeners.delete(listener);
	}
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.#schemes.add(listener);
		return () => this.#schemes.delete(listener);
	}
	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.#notifications === enabled) return;
		this.#notifications = enabled;
		if (!this.stopped) this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
	}
	#cancelTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.#requested = false;
		this.#cancelTimer();
		this.#lastRender = performance.now();
		this.doRender();
	}
	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.#immediately();
		} else if (!this.#requested) {
			this.#requested = true;
			process.nextTick(() => this.#schedule());
		}
	}
	#immediately(): void {
		this.#cancelTimer();
		this.#requested = true;
		if (this.#immediate) return;
		this.#immediate = true;
		process.nextTick(() => {
			this.#immediate = false;
			if (this.stopped || !this.#requested) return;
			this.#cancelTimer();
			this.#requested = false;
			this.#lastRender = performance.now();
			this.doRender();
		});
	}
	#schedule(): void {
		if (this.stopped || this.#timer || !this.#requested) return;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				if (this.stopped || !this.#requested) return;
				this.#requested = false;
				this.#lastRender = performance.now();
				this.doRender();
				if (this.#requested) this.#schedule();
			},
			Math.max(0, 16 - (performance.now() - this.#lastRender)),
		);
	}
	#colors(query: ColorQuery): TerminalColors {
		const palette: RgbColor[] = [];
		for (const color of query.palette) {
			if (color === undefined)
				return { foreground: query.foreground, background: query.background, palette: undefined };
			palette.push(color);
		}
		return { foreground: query.foreground, background: query.background, palette };
	}
	#finishQuery(query: ColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		deliver?.(this.#colors(query));
	}
	#consumeColors(data: string): boolean {
		const query = this.#queries[0];
		if (!query) return false;
		if (/^\x1b\[\?[\d;]*c$/.test(data)) {
			this.#queries.shift();
			this.#finishQuery(query);
			return true;
		}
		const response = parseOscColorResponse(data);
		if (!response) return false;
		const key = String(response.target);
		if (!query.deliver || query.replied.has(key)) return true;
		query.replied.add(key);
		if (response.target === "foreground") query.foreground = response.rgb;
		else if (response.target === "background") query.background = response.rgb;
		else if (response.target < 16) query.palette[response.target] = response.rgb;
		if (query.replied.size === 18) this.#finishQuery(query);
		return true;
	}
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: ColorQuery = {
				palette: Array.from({ length: 16 }, () => undefined),
				replied: new Set(),
				deliver: resolve,
			};
			query.timer = setTimeout(() => {
				query.deliver = options.onLateReply;
				resolve(this.#colors(query));
			}, options.timeoutMs);
			this.#queries.push(query);
			this.terminal.write(
				"\x1b]10;?\x07\x1b]11;?\x07" +
					Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};?\x07`).join("") +
					"\x1b[c",
			);
		});
	}
	#input(data: string): void {
		if (this.#consumeColors(data)) return;
		const scheme = parseTerminalColorSchemeReport(data);
		if (scheme) {
			for (const listener of this.#schemes) listener(scheme);
			return;
		}
		if (this.#listeners.size) {
			for (const listener of this.#listeners) {
				const result = listener(data);
				if (result?.consume) return;
				if (result?.data !== undefined) data = result.data;
			}
			if (!data.length) return;
		}
		const cell = /^\x1b\[6;(\d+);(\d+)t$/.exec(data);
		if (cell) {
			const heightPx = Number(cell[1]),
				widthPx = Number(cell[2]);
			if (heightPx > 0 && widthPx > 0) {
				setCellDimensions({ widthPx, heightPx });
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}
		const focusedOverlay = this.#overlays.find((entry) => entry.component === this.#focused);
		if (focusedOverlay && !this.#visible(focusedOverlay)) {
			const front = this.#front();
			if (front) this.setFocus(front.component);
			else this.#focus(focusedOverlay.previous, true);
		}
		if (!this.#overlays.some((entry) => entry.component === this.#focused)) {
			const restore = this.#activeRestore();
			if (restore.kind === "eligible") this.setFocus(restore.overlay.component);
			else if (restore.kind === "blocked" && restore.blocker !== this.#focused) {
				if (restore.resume.kind === "overlay") this.setFocus(restore.overlay.component);
				else {
					this.#restore = { kind: "none" };
					this.setFocus(restore.resume.target);
				}
			}
		}
		if (this.#focused?.handleInput) {
			if (isKeyRelease(data) && !this.#focused.wantsKeyRelease) return;
			this.#focused.handleInput(data);
			this.#immediately();
		}
	}
	#overlayLayout(
		options: OverlayOptions = {},
		height: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const margin =
			typeof options.margin === "number"
				? { top: options.margin, left: options.margin, bottom: options.margin, right: options.margin }
				: (options.margin ?? {});
		const top = Math.max(0, margin.top ?? 0),
			left = Math.max(0, margin.left ?? 0),
			bottom = Math.max(0, margin.bottom ?? 0),
			right = Math.max(0, margin.right ?? 0);
		const availableWidth = Math.max(1, termWidth - left - right),
			availableHeight = Math.max(1, termHeight - top - bottom);
		const width = Math.max(
			1,
			Math.min(
				availableWidth,
				Math.max(size(options.width, termWidth) ?? Math.min(80, availableWidth), options.minWidth ?? -Infinity),
			),
		);
		const requestedHeight = size(options.maxHeight, termHeight),
			maxHeight = requestedHeight === undefined ? undefined : Math.max(1, Math.min(requestedHeight, availableHeight));
		const actualHeight = maxHeight === undefined ? height : Math.min(height, maxHeight);
		const anchor = options.anchor ?? "center";
		const rowAnchor = anchor.startsWith("top-")
			? top
			: anchor.startsWith("bottom-")
				? top + availableHeight - actualHeight
				: top + Math.floor((availableHeight - actualHeight) / 2);
		const colAnchor =
			anchor.endsWith("-left") || anchor === "left-center"
				? left
				: anchor.endsWith("-right") || anchor === "right-center"
					? left + availableWidth - width
					: left + Math.floor((availableWidth - width) / 2);
		const position = (value: SizeValue | undefined, origin: number, free: number, fallback: number): number =>
			typeof value === "number"
				? value
				: value !== undefined
					? /^\d+(?:\.\d+)?%$/.test(value)
						? origin + Math.floor((Math.max(0, free) * Number.parseFloat(value)) / 100)
						: origin + Math.floor(free / 2)
					: fallback;
		const row = position(options.row, top, availableHeight - actualHeight, rowAnchor) + (options.offsetY ?? 0),
			col = position(options.col, left, availableWidth - width, colAnchor) + (options.offsetX ?? 0);
		return {
			width,
			row: Math.max(top, Math.min(row, termHeight - bottom - actualHeight)),
			col: Math.max(left, Math.min(col, termWidth - right - width)),
			maxHeight,
		};
	}
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		this.#drawnOverlays = [];
		if (!this.#overlays.length) return lines;
		const result = [...lines],
			rendered: { entry: Overlay; bounds: OverlayBounds; lines: string[] }[] = [];
		let required = result.length;
		for (const entry of this.#overlays) entry.bounds = undefined;
		for (const entry of this.#overlays
			.filter((entry) => this.#visible(entry))
			.sort((left, right) => left.order - right.order)) {
			const first = this.#overlayLayout(entry.options, 0, termWidth, termHeight);
			let content = this.resolveFakeCursors(entry.component.render(first.width));
			if (first.maxHeight !== undefined) content = content.slice(0, first.maxHeight);
			const placement = this.#overlayLayout(entry.options, content.length, termWidth, termHeight);
			const bounds = { width: first.width, row: placement.row, col: placement.col, height: content.length };
			entry.bounds = bounds;
			rendered.push({ entry, bounds, lines: content });
			this.#drawnOverlays.push({ entry, bounds });
			required = Math.max(required, bounds.row + content.length);
		}
		const working = Math.max(result.length, termHeight, required);
		while (result.length < working) result.push("");
		const viewport = Math.max(0, working - termHeight);
		for (const { bounds, lines: content } of rendered)
			for (let index = 0; index < content.length; index++) {
				const row = viewport + bounds.row + index;
				if (row < 0 || row >= result.length) continue;
				const line =
					visibleWidth(content[index]) > bounds.width
						? sliceByColumn(content[index], 0, bounds.width, true)
						: content[index];
				result[row] = compositeTuiLine(result[row], line, bounds.col, bounds.width, termWidth);
			}
		return result;
	}
	protected applyLineResets(lines: string[]): string[] {
		for (let index = 0; index < lines.length; index++)
			if (!isImageLine(lines[index])) lines[index] = normalizeTerminalOutput(lines[index]) + lineReset;
		return lines;
	}
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		for (let row = lines.length - 1; row >= Math.max(0, lines.length - height); row--) {
			const index = lines[row].indexOf(CURSOR_MARKER);
			if (index >= 0) {
				const col = visibleWidth(lines[row].slice(0, index));
				lines[row] = lines[row].slice(0, index) + lines[row].slice(index + CURSOR_MARKER.length);
				return { row, col };
			}
		}
		return null;
	}
	protected resolveFakeCursors(lines: string[]): string[] {
		return lines.map((line) => {
			if (!line.includes(FAKE_CURSOR_START)) return line;
			if (this.#hardware) {
				const start = line.indexOf(CURSOR_MARKER + FAKE_CURSOR_START);
				if (start >= 0) {
					const content = start + CURSOR_MARKER.length + FAKE_CURSOR_START.length,
						end = line.indexOf(FAKE_CURSOR_END, content);
					line =
						line.slice(0, start + CURSOR_MARKER.length) +
						(end < 0 ? line.slice(content) : line.slice(content, end) + line.slice(end + FAKE_CURSOR_END.length));
				}
			}
			return line.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
		});
	}
}
