import { expect, test, vi } from "vitest";
import { Input } from "../src/components/input.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import {
	calculateImageRows,
	getCapabilities,
	getCellDimensions,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { TestTerminal } from "./support/terminal.ts";

test.each([
	{ name: "main screen", Screen: TuiMainScreen },
	{ name: "alternate screen", Screen: TuiAltScreen },
])(
	"$name consumes cell-size reports and uses their dimensions for images",
	({ Screen }) => {
		const terminal = new TestTerminal(30, 12),
			ui = new Screen(terminal),
			input = new Input();
		const previous = { cells: getCellDimensions(), capabilities: getCapabilities() };
		try {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const writes = vi.spyOn(terminal, "write");
			ui.addChild(input);
			ui.setFocus(input);
			ui.start();
			expect(writes).toHaveBeenCalledWith("\x1b[16t");
			terminal.input("\x1b[6;24;10t");
			expect(getCellDimensions()).toEqual({ widthPx: 10, heightPx: 24 });
			expect(calculateImageRows({ widthPx: 20, heightPx: 48 }, 2, getCellDimensions())).toBe(2);
			terminal.input("\x1b[6;0;10t");
			terminal.input("\x1b[6;24;0t");
			expect(getCellDimensions()).toEqual({ widthPx: 10, heightPx: 24 });
			terminal.input("draft");
			expect(input.getValue()).toBe("draft");
			expect(calculateImageRows({ widthPx: 18, heightPx: 36 }, 2)).toBe(2);
		} finally {
			ui.stop();
			terminal.dispose();
			setCapabilities(previous.capabilities);
			setCellDimensions(previous.cells);
			vi.restoreAllMocks();
		}
	},
);
