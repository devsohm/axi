import { type KeyId, matchesKey } from "./keys.ts";

export interface KeybindingDefinition {
	defaultKeys: KeyId | KeyId[];
	description?: string;
}
export type KeybindingDefinitions = Record<string, KeybindingDefinition>;
export type KeybindingsConfig = Record<string, KeyId | KeyId[] | undefined>;

export const TUI_KEYBINDINGS = {
	"tui.editor.cursorUp": { defaultKeys: "up", description: "Move up" },
	"tui.editor.cursorDown": { defaultKeys: "down", description: "Move down" },
	"tui.editor.historyPrevious": { defaultKeys: [], description: "Recall the previous prompt" },
	"tui.editor.historyNext": { defaultKeys: [], description: "Recall the next prompt" },
	"tui.editor.cursorLeft": { defaultKeys: ["left", "ctrl+b"], description: "Move left" },
	"tui.editor.cursorRight": { defaultKeys: ["right", "ctrl+f"], description: "Move right" },
	"tui.editor.cursorWordLeft": {
		defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
		description: "Move to the preceding word",
	},
	"tui.editor.cursorWordRight": {
		defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
		description: "Move to the following word",
	},
	"tui.editor.cursorLineStart": {
		defaultKeys: ["home", "ctrl+a"],
		description: "Move to the start of the line",
	},
	"tui.editor.cursorLineEnd": {
		defaultKeys: ["end", "ctrl+e"],
		description: "Move to the end of the line",
	},
	"tui.editor.jumpForward": { defaultKeys: "ctrl+]", description: "Find a character ahead" },
	"tui.editor.jumpBackward": { defaultKeys: "ctrl+alt+]", description: "Find a character behind" },
	"tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Move up one page" },
	"tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Move down one page" },
	"tui.editor.deleteCharBackward": { defaultKeys: "backspace", description: "Delete the preceding character" },
	"tui.editor.deleteCharForward": { defaultKeys: ["delete", "ctrl+d"], description: "Delete the following character" },
	"tui.editor.deleteWordBackward": {
		defaultKeys: ["ctrl+w", "alt+backspace"],
		description: "Delete the preceding word",
	},
	"tui.editor.deleteWordForward": { defaultKeys: ["alt+d", "alt+delete"], description: "Delete the following word" },
	"tui.editor.deleteToLineStart": { defaultKeys: "ctrl+u", description: "Delete back to the line start" },
	"tui.editor.deleteToLineEnd": { defaultKeys: "ctrl+k", description: "Delete through the line end" },
	"tui.editor.yank": { defaultKeys: "ctrl+y", description: "Paste deleted text" },
	"tui.editor.yankPop": { defaultKeys: "alt+y", description: "Cycle deleted text" },
	"tui.editor.undo": { defaultKeys: "ctrl+-", description: "Restore the previous edit" },
	"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Add a newline" },
	"tui.input.submit": { defaultKeys: "enter", description: "Submit text" },
	"tui.input.tab": { defaultKeys: "tab", description: "Complete input" },
	"tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selected text" },
	"tui.select.up": { defaultKeys: "up", description: "Select the preceding item" },
	"tui.select.down": { defaultKeys: "down", description: "Select the following item" },
	"tui.select.pageUp": { defaultKeys: "pageUp", description: "Move selection up a page" },
	"tui.select.pageDown": { defaultKeys: "pageDown", description: "Move selection down a page" },
	"tui.select.confirm": { defaultKeys: "enter", description: "Accept the selected item" },
	"tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"], description: "Cancel selection" },
	"tui.altScreen.pageUp": { defaultKeys: "pageUp", description: "Scroll up a page" },
	"tui.altScreen.pageDown": { defaultKeys: "pageDown", description: "Scroll down a page" },
	"tui.altScreen.halfPageUp": { defaultKeys: [], description: "Scroll up half a page" },
	"tui.altScreen.halfPageDown": { defaultKeys: [], description: "Scroll down half a page" },
	"tui.altScreen.lineUp": { defaultKeys: [], description: "Scroll up one line" },
	"tui.altScreen.lineDown": { defaultKeys: [], description: "Scroll down one line" },
	"tui.altScreen.previousPrompt": {
		defaultKeys: ["ctrl+shift+up", "ctrl+up"],
		description: "Show the preceding prompt",
	},
	"tui.altScreen.nextPrompt": {
		defaultKeys: ["ctrl+shift+down", "ctrl+down"],
		description: "Show the following prompt",
	},
	"tui.altScreen.search": { defaultKeys: "ctrl+shift+f", description: "Search conversation text" },
	"tui.altScreen.searchNext": { defaultKeys: ["enter", "ctrl+g"], description: "Show the next match" },
	"tui.altScreen.searchPrevious": {
		defaultKeys: ["shift+enter", "ctrl+shift+g"],
		description: "Show the previous match",
	},
	"tui.altScreen.searchClose": { defaultKeys: "escape", description: "Close search" },
	"tui.altScreen.top": { defaultKeys: "ctrl+home", description: "Scroll to the beginning" },
	"tui.altScreen.bottom": { defaultKeys: "ctrl+end", description: "Scroll to the end" },
} satisfies KeybindingDefinitions;

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
		for (const [id, assigned] of this.#resolved) output[id] = assigned.length === 1 ? assigned[0] : [...assigned];
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
