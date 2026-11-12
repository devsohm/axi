import { type KeyId, matchesKey } from "./keys.ts";

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}
export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
	"tui.editor.historyPrevious": { defaultKeys: [], description: "Select previous prompt history entry" },
	"tui.editor.historyNext": { defaultKeys: [], description: "Select next prompt history entry" },
	"tui.editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"], description: "Move cursor left" },
	"tui.editor.cursorRight": { defaultKeys: ["right", "ctrl+f"], description: "Move cursor right" },
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move cursor word left",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move cursor word right",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to line start",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to line end",
	},
	"tui.editor.jumpForward": { defaultKeys: "ctrl+]", description: "Jump forward to character" },
	"tui.editor.jumpBackward": { defaultKeys: "ctrl+alt+]", description: "Jump backward to character" },
	"tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Page up" },
	"tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Page down" },
	"tui.editor.deleteCharBackward": { defaultKeys: "backspace", description: "Delete character backward" },
	"tui.editor.deleteCharForward": { defaultKeys: ["delete", "ctrl+d"], description: "Delete character forward" },
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete word backward",
	},
	"tui.editor.deleteWordForward": { defaultKeys: ["alt+d", "alt+delete"], description: "Delete word forward" },
	"tui.editor.deleteToLineStart": { defaultKeys: "ctrl+u", description: "Delete to line start" },
	"tui.editor.deleteToLineEnd": { defaultKeys: "ctrl+k", description: "Delete to line end" },
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
	"tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
	"tui.select.up": { defaultKeys: "up", description: "Move selection up" },
	"tui.select.down": { defaultKeys: "down", description: "Move selection down" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
	"tui.select.pageDown": { defaultKeys: "pageDown", description: "Selection page down" },
	"tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
	"tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"], description: "Cancel selection" },
	"tui.altScreen.pageUp": { defaultKeys: "pageUp", description: "Scroll viewport up one page" },
	"tui.altScreen.pageDown": { defaultKeys: "pageDown", description: "Scroll viewport down one page" },
	"tui.altScreen.halfPageUp": { defaultKeys: [], description: "Scroll viewport up half a page" },
	"tui.altScreen.halfPageDown": { defaultKeys: [], description: "Scroll viewport down half a page" },
	"tui.altScreen.lineUp": { defaultKeys: [], description: "Scroll viewport up one line" },
	"tui.altScreen.lineDown": { defaultKeys: [], description: "Scroll viewport down one line" },
	"tui.altScreen.previousPrompt": {
		defaultKeys: ["ctrl+shift+up", "ctrl+up"],
		description: "Jump to previous semantic prompt",
	},
	"tui.altScreen.nextPrompt": {
		defaultKeys: ["ctrl+shift+down", "ctrl+down"],
		description: "Jump to next semantic prompt",
	},
	"tui.altScreen.search": { defaultKeys: "ctrl+shift+f", description: "Search the primary scroll view" },
	"tui.altScreen.searchNext": { defaultKeys: ["enter", "ctrl+g"], description: "Select the next search match" },
	"tui.altScreen.searchPrevious": {
		defaultKeys: ["shift+enter", "ctrl+shift+g"],
		description: "Select the previous search match",
	},
	"tui.altScreen.searchClose": { defaultKeys: "escape", description: "Close transcript search" },
	"tui.altScreen.top": { defaultKeys: "ctrl+home", description: "Scroll viewport to top" },
	"tui.altScreen.bottom": { defaultKeys: "ctrl+end", description: "Scroll viewport to bottom" },
} as const satisfies KeybindingDefinitions;

export interface Keybindings extends Record<keyof typeof TUI_KEYBINDINGS, true> {}
export type Keybinding = keyof Keybindings;
export interface KeybindingConflict {
	key: KeyId;
	keybindings: string[];
}

function keys(value: KeyId | KeyId[] | undefined): KeyId[] {
	return [...new Set(value === undefined ? [] : Array.isArray(value) ? value : [value])];
}

export class KeybindingsManager {
	readonly #definitions: KeybindingDefinitions;
	#user: KeybindingsConfig;
	#resolved = new Map<string, KeyId[]>();
	#conflicts: KeybindingConflict[] = [];

	constructor(definitions: KeybindingDefinitions, userBindings: KeybindingsConfig = {}) {
		this.#definitions = definitions;
		this.#user = userBindings;
		this.#rebuild();
	}

	#rebuild(): void {
		this.#resolved.clear();
		const claims = new Map<KeyId, string[]>();
		for (const [id, value] of Object.entries(this.#user)) {
			if (!(id in this.#definitions)) continue;
			for (const key of keys(value)) {
				const owners = claims.get(key) ?? [];
				owners.push(id);
				claims.set(key, owners);
			}
		}
		this.#conflicts = [];
		for (const [key, keybindings] of claims) if (keybindings.length > 1) this.#conflicts.push({ key, keybindings });
		for (const [id, definition] of Object.entries(this.#definitions))
			this.#resolved.set(id, keys(this.#user[id] ?? definition.defaultKeys));
	}

	matches(data: string, keybinding: Keybinding): boolean {
		return this.#resolved.get(keybinding)?.some((key) => matchesKey(data, key)) ?? false;
	}
	getKeys(keybinding: Keybinding): KeyId[] {
		return [...(this.#resolved.get(keybinding) ?? [])];
	}
	getDefinition(keybinding: Keybinding): KeybindingDefinition {
		return this.#definitions[keybinding];
	}
	getConflicts(): KeybindingConflict[] {
		return this.#conflicts.map(({ key, keybindings }) => ({ key, keybindings: [...keybindings] }));
	}
	setUserBindings(userBindings: KeybindingsConfig): void {
		this.#user = userBindings;
		this.#rebuild();
	}
	getUserBindings(): KeybindingsConfig {
		return { ...this.#user };
	}
	getResolvedBindings(): KeybindingsConfig {
		const output: KeybindingsConfig = {};
		for (const id of Object.keys(this.#definitions)) {
			const assigned = this.#resolved.get(id) ?? [];
			output[id] = assigned.length === 1 ? assigned[0] : [...assigned];
		}
		return output;
	}
}

let current: KeybindingsManager | undefined;
export function setKeybindings(manager: KeybindingsManager): void {
	current = manager;
}
export function getKeybindings(): KeybindingsManager {
	return (current ??= new KeybindingsManager(TUI_KEYBINDINGS));
}

export function getSelectPageIndex(
	keybindings: KeybindingsManager,
	data: string,
	selectedIndex: number,
	itemCount: number,
	pageSize: number,
): number | undefined {
	const delta = keybindings.matches(data, "tui.select.pageUp")
		? -pageSize
		: keybindings.matches(data, "tui.select.pageDown")
			? pageSize
			: undefined;
	return delta === undefined ? undefined : Math.max(0, Math.min(itemCount - 1, selectedIndex + delta));
}
