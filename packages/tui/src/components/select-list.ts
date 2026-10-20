import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}
export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}
export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}
export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	readonly #items: SelectItem[];
	#filtered: SelectItem[];
	#selected = 0;
	#pressed: number | undefined;
	readonly #limit: number;
	readonly #theme: SelectListTheme;
	readonly #layout: SelectListLayoutOptions;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.#items = items;
		this.#filtered = items;
		this.#limit = maxVisible;
		this.#theme = theme;
		this.#layout = layout;
	}
	invalidate(): void {}
	setFilter(filter: string): void {
		this.#filtered = this.#items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		this.#selected = 0;
	}
	setSelectedIndex(index: number): void {
		this.#selected = Math.max(0, Math.min(index, this.#filtered.length - 1));
	}
	getSelectedItem(): SelectItem | null {
		return this.#filtered[this.#selected] ?? null;
	}
	#notify(): void {
		const item = this.getSelectedItem();
		if (item) this.onSelectionChange?.(item);
	}
	#range(): { start: number; end: number } {
		const start = Math.max(
			0,
			Math.min(this.#selected - Math.floor(this.#limit / 2), this.#filtered.length - this.#limit),
		);
		return { start, end: Math.min(start + this.#limit, this.#filtered.length) };
	}
	#primary(item: SelectItem, selected: boolean, width: number, columnWidth: number): string {
		const text = item.label || item.value;
		return truncateToWidth(
			this.#layout.truncatePrimary?.({ text, maxWidth: width, columnWidth, item, isSelected: selected }) ??
				truncateToWidth(text, width, ""),
			width,
			"",
		);
	}
	#renderItem(item: SelectItem, index: number, width: number, primaryWidth: number): string {
		const selected = index === this.#selected,
			prefix = selected ? "→ " : "  ";
		const description = item.description?.replace(/[\r\n]+/g, " ").trim();
		if (description && width > 40) {
			const column = Math.max(1, Math.min(primaryWidth, width - visibleWidth(prefix) - 4));
			const label = this.#primary(item, selected, Math.max(1, column - 2), column);
			const gap = " ".repeat(Math.max(1, column - visibleWidth(label)));
			const remaining = width - visibleWidth(prefix) - visibleWidth(label) - gap.length - 2;
			if (remaining > 10) {
				const detail = truncateToWidth(description, remaining, "");
				return selected
					? this.#theme.selectedText(prefix + label + gap + detail)
					: prefix + label + this.#theme.description(gap + detail);
			}
		}
		const available = width - visibleWidth(prefix) - 2;
		const label = prefix + this.#primary(item, selected, available, available);
		return selected ? this.#theme.selectedText(label) : label;
	}
	render(width: number): string[] {
		if (!this.#filtered.length) return [this.#theme.noMatch("  No matching commands")];
		const minimum = this.#layout.minPrimaryColumnWidth ?? this.#layout.maxPrimaryColumnWidth ?? 32;
		const maximum = this.#layout.maxPrimaryColumnWidth ?? this.#layout.minPrimaryColumnWidth ?? 32;
		const widest = this.#filtered.reduce(
			(current, item) => Math.max(current, visibleWidth(item.label || item.value) + 2),
			0,
		);
		const column = Math.max(
			Math.max(1, Math.min(minimum, maximum)),
			Math.min(widest, Math.max(1, Math.max(minimum, maximum))),
		);
		const { start, end } = this.#range();
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const item = this.#filtered[index];
			if (item) lines.push(this.#renderItem(item, index, width, column));
		}
		if (start > 0 || end < this.#filtered.length)
			lines.push(
				this.#theme.scrollInfo(truncateToWidth(`  (${this.#selected + 1}/${this.#filtered.length})`, width - 2, "")),
			);
		return lines;
	}
	handleInput(data: string): void {
		const bindings = getKeybindings();
		if (bindings.matches(data, "tui.select.up")) {
			this.#selected = this.#selected === 0 ? this.#filtered.length - 1 : this.#selected - 1;
			this.#notify();
		} else if (bindings.matches(data, "tui.select.down")) {
			this.#selected = this.#selected === this.#filtered.length - 1 ? 0 : this.#selected + 1;
			this.#notify();
		} else if (bindings.matches(data, "tui.select.confirm")) {
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
		} else if (bindings.matches(data, "tui.select.cancel")) this.onCancel?.();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.#filtered.length) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const previous = this.#selected;
			this.#selected = Math.max(0, Math.min(this.#filtered.length - 1, previous + (event.wheelDelta < 0 ? -1 : 1)));
			if (previous !== this.#selected) this.#notify();
			return { handled: true, render: previous !== this.#selected };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { start, end } = this.#range(),
			index = start + event.y;
		if (index < start || index >= end) return undefined;
		if (event.type === "press") {
			this.#pressed = index;
			if (this.#selected !== index) {
				this.#selected = index;
				this.#notify();
			}
			return { handled: true, focus: true };
		}
		const selected = this.#pressed ?? index;
		this.#pressed = undefined;
		if (this.#selected !== selected) {
			this.#selected = selected;
			this.#notify();
		}
		const item = this.getSelectedItem();
		if (item) this.onSelect?.(item);
		return { handled: true };
	}
}
