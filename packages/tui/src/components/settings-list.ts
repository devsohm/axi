import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}
export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}
export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	readonly #items: SettingItem[];
	#filtered: SettingItem[];
	readonly #limit: number;
	readonly #theme: SettingsListTheme;
	readonly #change: (id: string, value: string) => void;
	readonly #cancel: () => void;
	readonly #search: Input | undefined;
	#selected = 0;
	#pressed: number | undefined;
	#submenu: Component | undefined;
	#submenuIndex: number | undefined;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.#items = items;
		this.#filtered = items;
		this.#limit = maxVisible;
		this.#theme = theme;
		this.#change = onChange;
		this.#cancel = onCancel;
		if (options.enableSearch) this.#search = new Input();
	}
	#display(): SettingItem[] {
		return this.#search ? this.#filtered : this.#items;
	}
	#range(): { start: number; end: number } {
		const length = this.#display().length;
		const start = Math.max(0, Math.min(this.#selected - Math.floor(this.#limit / 2), length - this.#limit));
		return { start, end: Math.min(start + this.#limit, length) };
	}
	updateValue(id: string, newValue: string): void {
		const item = this.#items.find((value) => value.id === id);
		if (item) item.currentValue = newValue;
	}
	selectItem(id: string): void {
		const index = this.#display().findIndex((item) => item.id === id);
		if (index >= 0) this.#selected = index;
	}
	invalidate(): void {
		this.#submenu?.invalidate?.();
	}
	#hint(lines: string[], width: number): void {
		lines.push(
			"",
			truncateToWidth(
				this.#theme.hint(
					this.#search
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
	render(width: number): string[] {
		if (this.#submenu) return this.#submenu.render(width);
		const lines: string[] = this.#search ? [...this.#search.render(width), ""] : [];
		if (!this.#items.length) {
			lines.push(this.#theme.hint("  No settings available"));
			if (this.#search) this.#hint(lines, width);
			return lines;
		}
		const items = this.#display();
		if (!items.length) {
			lines.push(truncateToWidth(this.#theme.hint("  No matching settings"), width));
			this.#hint(lines, width);
			return lines;
		}
		const labelWidth = Math.min(36, Math.max(...this.#items.map((item) => visibleWidth(item.label))));
		const { start, end } = this.#range();
		for (let index = start; index < end; index++) {
			const item = items[index];
			if (!item) continue;
			const selected = index === this.#selected,
				prefix = selected ? this.#theme.cursor : "  ";
			const label = item.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
			const valueWidth = width - visibleWidth(prefix) - labelWidth - 4;
			lines.push(
				truncateToWidth(
					prefix +
						this.#theme.label(label, selected) +
						"  " +
						this.#theme.value(truncateToWidth(item.currentValue, valueWidth, ""), selected),
					width,
				),
			);
		}
		if (start > 0 || end < items.length)
			lines.push(this.#theme.hint(truncateToWidth(`  (${this.#selected + 1}/${items.length})`, width - 2, "")));
		const description = items[this.#selected]?.description;
		if (description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(description, width - 4)) lines.push(this.#theme.description("  " + line));
		}
		this.#hint(lines, width);
		return lines;
	}
	#activate(): void {
		const item = this.#display()[this.#selected];
		if (!item) return;
		if (item.submenu) {
			this.#submenuIndex = this.#selected;
			this.#submenu = item.submenu(item.currentValue, (value, options) => {
				if (value !== undefined) {
					item.currentValue = value;
					this.#change(item.id, value);
				}
				this.#submenu = undefined;
				if (options?.navigateTo) {
					this.#submenuIndex = undefined;
					this.selectItem(options.navigateTo);
					this.#activate();
				} else if (this.#submenuIndex !== undefined) {
					this.#selected = this.#submenuIndex;
					this.#submenuIndex = undefined;
				}
			});
		} else if (item.values?.length) {
			const value = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length];
			item.currentValue = value;
			this.#change(item.id, value);
		}
	}
	handleInput(data: string): void {
		if (this.#submenu) {
			this.#submenu.handleInput?.(data);
			return;
		}
		const bindings = getKeybindings(),
			items = this.#display();
		if (bindings.matches(data, "tui.select.up")) {
			if (items.length) this.#selected = this.#selected === 0 ? items.length - 1 : this.#selected - 1;
		} else if (bindings.matches(data, "tui.select.down")) {
			if (items.length) this.#selected = this.#selected === items.length - 1 ? 0 : this.#selected + 1;
		} else if (
			bindings.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.#search || this.#search.getValue().length === 0))
		)
			this.#activate();
		else if (bindings.matches(data, "tui.select.cancel")) this.#cancel();
		else if (this.#search) {
			this.#search.handleInput(data);
			this.#filtered = fuzzyFilter(this.#items, this.#search.getValue(), (item) => item.label);
			this.#selected = 0;
		}
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.#submenu || (this.#search && event.y === 0)) {
			const result = (this.#submenu ?? this.#search)?.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}
		if (this.#search && event.y === 1) return undefined;
		const items = this.#display();
		if (!items.length) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const previous = this.#selected;
			this.#selected = Math.max(0, Math.min(items.length - 1, previous + (event.wheelDelta < 0 ? -1 : 1)));
			return { handled: true, render: this.#selected !== previous };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { start, end } = this.#range(),
			index = start + event.y - (this.#search ? 2 : 0);
		if (index < start || index >= end) return undefined;
		if (event.type === "press") {
			this.#pressed = index;
			this.#selected = index;
			return { handled: true, focus: true };
		}
		this.#selected = this.#pressed ?? index;
		this.#pressed = undefined;
		this.#activate();
		return { handled: true };
	}
}
