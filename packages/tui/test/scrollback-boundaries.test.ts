import { afterEach, expect, test, vi } from "vitest";
import { encodeKitty, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiMainScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
});
function setup() {
	const terminal = new TestTerminal(24, 8),
		ui = new TuiMainScreen(terminal);
	resources.push({ ui, terminal });
	return { ui, terminal };
}

test.each([-1, 0, 1])("large terminal writes preserve UTF-16 pairs at chunk offset %i", (offset) => {
	const { ui, terminal } = setup();
	const writes = vi.spyOn(terminal, "write").mockImplementation(() => {});
	const chunkSize = 1024 * 1024,
		prefix = "\x1b]8;;",
		synchronizedStart = "\x1b[?2026h";
	const line =
		prefix +
		"a".repeat(chunkSize - synchronizedStart.length - prefix.length - 1 + offset) +
		"🙂" +
		"b".repeat(chunkSize) +
		"\x07link\x1b]8;;\x07";
	ui.addChild({ render: () => [line], invalidate() {} });
	ui.renderNow();
	const chunks = writes.mock.calls.map(([data]) => data);
	expect(chunks.join("")).toContain(line);
	expect(chunks.length).toBeGreaterThanOrEqual(3);
	for (const chunk of chunks) {
		expect(chunk.length).toBeLessThanOrEqual(chunkSize);
		expect(chunk.isWellFormed()).toBe(true);
	}
});

test("capturing and restoring render state preserves isolation and forces inline image retransmission", async () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const { ui, terminal } = setup(),
		writes = vi.spyOn(terminal, "write");
	const image = encodeKitty("AQ==", { imageId: 91001, rows: 3, columns: 2, moveCursor: false });
	const lines = ["heading", image, "", "", "footer"];
	ui.addChild({ render: () => lines, invalidate() {} });
	ui.renderNow();
	const captured = ui.captureRenderState(),
		original = [...captured.previousLines];
	captured.previousLines[0] = "caller edit";
	expect(ui.captureRenderState().previousLines[0]).toContain("heading");
	captured.previousLines = original;
	ui.restoreRenderState(captured);
	captured.previousLines[0] = "another caller edit";
	expect(ui.captureRenderState().previousLines.map(stripTerminalSequences)).toEqual(["heading", "", "", "", "footer"]);
	writes.mockClear();
	ui.renderNow();
	const output = writes.mock.calls.map(([data]) => data).join("");
	expect(output).toContain(image);
	expect(output).toContain("\x1b[2A");
	await terminal.screen();
});

test("deleting a visible tail clears every removed line and an empty render leaves no old content", async () => {
	const { ui, terminal } = setup();
	let lines = ["one", "two", "three", "four"];
	ui.addChild({ render: () => lines, invalidate() {} });
	ui.renderNow();
	expect((await terminal.screen()).slice(0, 4)).toEqual(lines);
	lines = ["one", "two"];
	ui.renderNow();
	expect((await terminal.screen()).slice(0, 5)).toEqual(["one", "two", "", "", ""]);
	lines = [];
	ui.renderNow();
	expect((await terminal.screen()).every((line) => line === "")).toBe(true);
	expect(ui.captureRenderState().previousLines).toEqual([]);
});

test("forced redraw invalidates saved geometry and returns the cursor to the current marker", async () => {
	const { ui, terminal } = setup();
	ui.setShowHardwareCursor(true);
	ui.addChild({ render: () => ["heading", `ab${CURSOR_MARKER}cd`], invalidate: vi.fn() });
	ui.renderNow();
	await terminal.screen();
	const previous = ui.fullRedraws;
	ui.requestRender(true);
	ui.renderNow();
	await terminal.screen();
	expect(ui.fullRedraws).toBe(previous + 1);
	expect(terminal.emulator.buffer.active.cursorX).toBe(2);
	expect(terminal.emulator.buffer.active.cursorY).toBe(1);
});

test("Termux height changes preserve content while a later edit above the viewport forces a clean redraw", async () => {
	vi.stubEnv("TERMUX_VERSION", "test-session");
	const { ui, terminal } = setup();
	const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
	ui.addChild({ render: () => lines, invalidate() {} });
	ui.renderNow();
	await terminal.screen();
	const redraws = ui.fullRedraws;
	terminal.resize(24, 6);
	ui.renderNow();
	await terminal.screen();
	expect(ui.fullRedraws).toBe(redraws);
	lines[0] = "edited heading";
	ui.renderNow();
	expect(ui.fullRedraws).toBe(redraws + 1);
	expect((await terminal.screen()).slice(-3)).toEqual(["line 9", "line 10", "line 11"]);
});
