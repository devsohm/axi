import type { Component, Terminal } from "../src/index.ts";
import type { TUI_KEYBINDINGS } from "../src/keybindings.ts";

export function checkBuiltInBindingTypes(bindings: typeof TUI_KEYBINDINGS): void {
	// @ts-expect-error Built-in defaults are read-only; applications supply overrides.
	bindings["tui.input.submit"].defaultKeys = "enter";
}

export function configureViewportInput(component: Component): void {
	component.capturesViewportInput = true;
	component.capturesViewportInput = false;
}

export function checkTerminalProperties(terminal: Terminal): void {
	// @ts-expect-error Terminal dimensions are supplied by the terminal.
	terminal.columns = 80;
	// @ts-expect-error Terminal dimensions are supplied by the terminal.
	terminal.rows = 24;
	// @ts-expect-error Keyboard negotiation owns the active protocol.
	terminal.kittyProtocolActive = true;
}
