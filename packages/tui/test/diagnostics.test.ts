import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProcessTerminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { TestTerminal } from "./support/terminal.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

test("redraw reasons and overflow dumps include the rendering context", () => {
	const directory = mkdtempSync(join(tmpdir(), "axi-diagnostics-"));
	const terminal = new TestTerminal(10, 4);
	const ui = new TuiMainScreen(terminal, undefined, directory);
	let lines = ["ready"];
	ui.addChild({ render: () => lines, invalidate() {} });
	vi.stubEnv("AXI_TUI_DEBUG_REDRAW", "1");
	try {
		ui.renderNow();
		terminal.columns = 12;
		ui.renderNow();
		expect(readFileSync(join(directory, "axi-tui-debug.log"), "utf8")).toContain(
			"fullRender: terminal width changed (10 -> 12) (prev=1, new=1, height=4)",
		);
		lines = ["ready", "x".repeat(13)];
		expect(() => ui.renderNow()).toThrow(
			"This is likely caused by a custom TUI component not truncating its output.\nUse visibleWidth() to measure and truncateToWidth() to truncate lines.",
		);
		expect(readFileSync(join(directory, "axi-tui-crash.log"), "utf8")).toContain(
			"Line 1 visible width: 13\n\n=== All rendered lines ===\n[0] (w=5) ready\u001b[0m\u001b]8;;\u0007\n[1] (w=13) xxxxxxxxxxxxx\u001b[0m\u001b]8;;\u0007\n",
		);
	} finally {
		ui.stop();
		terminal.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("terminal write logs use a local calendar timestamp when a directory is configured", () => {
	const directory = mkdtempSync(join(tmpdir(), "axi-write-log-"));
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
	vi.stubEnv("AXI_TUI_WRITE_LOG", directory);
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	try {
		new ProcessTerminal().write("hello");
		const file = `tui-2026-01-02_03-04-05-${process.pid}.log`;
		expect(readdirSync(directory)).toEqual([file]);
		expect(readFileSync(join(directory, file), "utf8")).toBe("hello");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
