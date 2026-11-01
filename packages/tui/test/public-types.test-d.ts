import type { Component, Terminal } from "../src/index.ts";

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
