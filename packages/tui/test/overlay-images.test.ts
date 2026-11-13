import { afterEach, expect, test, vi } from "vitest";
import {
	deleteKittyImage,
	encodeITerm2,
	encodeKitty,
	getImageLineExtent,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
	stripImageSequences,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import type { Component } from "../src/tui.ts";
import { TestTerminal } from "./support/terminal.ts";

const resources: { ui: TuiAltScreen | TuiMainScreen; terminal: TestTerminal }[] = [];
afterEach(() => {
	for (const { ui, terminal } of resources.splice(0)) {
		ui.stop();
		terminal.dispose();
	}
	resetCapabilitiesCache();
	vi.restoreAllMocks();
});
const content = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

for (const fullscreen of [false, true]) {
	test.each(["kitty", "iterm2"] as const)(
		`an intersecting %s image is hidden and restored, fullscreen=${fullscreen}`,
		async (protocol) => {
			setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
			const terminal = new TestTerminal(24, 8),
				writes = vi.spyOn(terminal, "write");
			const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
			resources.push({ ui, terminal });
			const imageId = 91001;
			registerKittyImageMetadata({ imageId, columns: 4, rows: 3, widthPx: 40, heightPx: 60 });
			const image =
				protocol === "kitty"
					? encodeKitty("AQ==", { imageId, columns: 4, rows: 3, moveCursor: false })
					: `\x1b[2A${encodeITerm2("AQ==", { width: 4, height: "auto" })}`;
			const root = content(protocol === "kitty" ? ["top", image, "", "", "end"] : ["top", "", "", image, "end"]);
			if (ui instanceof TuiAltScreen) ui.setLayoutRoot(root);
			else ui.addChild(root);
			ui.start();
			ui.renderNow();
			await terminal.screen();
			expect(writes.mock.calls.map(([value]) => value).join("")).toContain(image);
			writes.mockClear();
			const overlay = ui.showOverlay(content(["MENU"]), { row: 2, col: 1, width: 8 });
			ui.renderNow();
			await terminal.screen();
			const covered = writes.mock.calls.map(([value]) => value).join("");
			expect(covered).toContain("MENU");
			if (protocol === "kitty") expect(covered).not.toMatch(/\x1b_Ga=(?:T|p)/);
			else expect(covered).not.toContain("\x1b]1337;File=");
			if (protocol === "kitty") expect(covered).toContain(fullscreen ? "\x1b_Ga=d,d=a,q=2" : deleteKittyImage(imageId));
			writes.mockClear();
			overlay.hide();
			ui.renderNow();
			await terminal.screen();
			const restored = writes.mock.calls.map(([value]) => value).join("");
			if (protocol === "kitty" && fullscreen) {
				expect(restored).toContain("\x1b_Ga=p,q=2");
				expect(restored).toContain(`i=${imageId}`);
				expect(restored).not.toContain("\x1b_Ga=T");
			} else expect(restored).toContain(image);
		},
	);

	test(`a sidebar keeps a neighboring image visible, fullscreen=${fullscreen}`, async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new TestTerminal(24, 8),
			writes = vi.spyOn(terminal, "write");
		const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
		resources.push({ ui, terminal });
		const imageId = 91002;
		registerKittyImageMetadata({ imageId, columns: 4, rows: 3, widthPx: 40, heightPx: 60 });
		const image = encodeKitty("Ag==", { imageId, columns: 4, rows: 3, moveCursor: false }),
			root = content(["top", image, "", "", "end"]);
		if (ui instanceof TuiAltScreen) ui.setLayoutRoot(root);
		else ui.addChild(root);
		ui.start();
		ui.renderNow();
		await terminal.screen();
		writes.mockClear();
		ui.showOverlay(content(["SIDE", "SIDE", "SIDE"]), { row: 1, col: 12, width: 8 });
		ui.renderNow();
		const screen = await terminal.screen(),
			output = writes.mock.calls.map(([value]) => value).join("");
		expect(screen[2]?.slice(12)).toBe("SIDE");
		expect(output.lastIndexOf(`i=${imageId}`)).toBeGreaterThan(
			output.lastIndexOf(fullscreen ? "\x1b_Ga=d,d=a,q=2" : deleteKittyImage(imageId)),
		);
	});

	test(`the upper overlay hides an image owned by a lower overlay, fullscreen=${fullscreen}`, async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new TestTerminal(24, 8),
			writes = vi.spyOn(terminal, "write");
		const ui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
		resources.push({ ui, terminal });
		const image = encodeKitty("Aw==", { imageId: 91003, columns: 4, rows: 3, moveCursor: false });
		registerKittyImageMetadata({ imageId: 91003, columns: 4, rows: 3, widthPx: 40, heightPx: 60 });
		ui.start();
		ui.showOverlay(content([image, "", ""]), { row: 0, col: 0, width: 8 });
		ui.renderNow();
		await terminal.screen();
		expect(writes.mock.calls.map(([value]) => value).join("")).toContain(image);
		writes.mockClear();
		ui.showOverlay(content(["TOP"]), { row: 2, col: 0, width: 8 });
		ui.renderNow();
		await terminal.screen();
		expect(writes.mock.calls.map(([value]) => value).join("")).not.toMatch(/\x1b_Ga=(?:T|p)/);
		expect((await terminal.screen())[2]).toBe("TOP");
	});
}

test("image extents use cell coordinates and stripping retains neighboring text", () => {
	const kitty = encodeKitty("AQ==", { imageId: 91004, columns: 5, rows: 4, moveCursor: false });
	expect(getImageLineExtent(`\x1b[31m界${kitty}text`)).toEqual({ firstRow: 0, lastRow: 3, startCol: 2, endCol: 7 });
	registerKittyImageMetadata({ imageId: 91005, columns: 3, rows: 2, widthPx: 30, heightPx: 40 });
	expect(getImageLineExtent(encodeKitty("AQ==", { imageId: 91005 }))).toEqual({
		firstRow: 0,
		lastRow: 1,
		startCol: 0,
		endCol: 3,
	});
	expect(getImageLineExtent("\x1b_Ga=T;AQ==\x1b\\")?.endCol).toBe(Infinity);
	for (const width of ["auto", "50%", "100px"])
		expect(getImageLineExtent(encodeITerm2("AQ==", { width }))?.endCol).toBe(Infinity);
	const iterm = `\x1b[3A${encodeITerm2("AQ==", { width: 6 })}`;
	expect(getImageLineExtent(`abc${iterm}`)).toEqual({ firstRow: -3, lastRow: 0, startCol: 3, endCol: 9 });
	expect(getImageLineExtent("text")).toBeUndefined();
	expect(stripImageSequences(`left${kitty}middle${iterm}right`)).toBe("leftmiddleright");
});
