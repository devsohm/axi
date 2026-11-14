import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Input } from "../src/components/input.ts";
import { Text } from "../src/components/text.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { TestTerminal } from "./support/terminal.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
});

test("render diagnostics record the rendered content and bounded output size", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-render-diagnostics-")),
		debug = resolve("/tmp/tui"),
		marker = `diagnostic-${randomUUID()}`;
	const existing = await stat(debug).then(
		() => true,
		() => false,
	);
	const terminal = new TestTerminal(80, 8),
		ui = new TuiMainScreen(terminal, false, directory);
	try {
		vi.stubEnv("AXI_TUI_DEBUG", "1");
		vi.stubEnv("AXI_TUI_DEBUG_REDRAW", "1");
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const text = new Text(marker, 0, 0);
		ui.addChild(text);
		ui.start();
		ui.renderNow(true);
		text.setText(`${marker} updated`);
		ui.renderNow();
		expect((await terminal.screen())[0]).toBe(`${marker} updated`);
		const files = await readdir(debug),
			owned: string[] = [];
		for (const file of files) {
			const content = await readFile(join(debug, file), "utf8");
			if (!content.includes(marker)) continue;
			owned.push(file);
			expect(content).toMatch(/\[\d+ chars written in bounded chunks\]/);
			expect(content).toContain("=== newLines ===");
		}
		expect(owned.length).toBeGreaterThan(0);
		expect(await readFile(join(directory, "axi-tui-debug.log"), "utf8")).toContain("new=1, height=8");
	} finally {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
		for (const file of await readdir(debug).catch(() => [])) {
			if ((await readFile(join(debug, file), "utf8").catch(() => "")).includes(marker)) await rm(join(debug, file));
		}
		if (!existing) await rmdir(debug).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

test("removing an input listener stops translation while the focused editor keeps receiving input", async () => {
	const terminal = new TestTerminal(30, 8),
		ui = new TuiMainScreen(terminal),
		input = new Input();
	const listener = (data: string) => ({ data: data.toUpperCase() });
	try {
		ui.addChild(input);
		ui.setFocus(input);
		ui.addInputListener(listener);
		ui.start();
		terminal.input("a");
		ui.removeInputListener(listener);
		ui.removeInputListener(listener);
		terminal.input("b");
		ui.renderNow();
		expect(input.getValue()).toBe("Ab");
		expect((await terminal.screen())[0]).toContain("Ab");
	} finally {
		ui.stop({ preserveScreen: true });
		terminal.dispose();
	}
});
