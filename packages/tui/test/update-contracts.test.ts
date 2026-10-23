import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { Markdown } from "../src/components/markdown.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { resetCapabilitiesCache, getCapabilities } from "../src/terminal-image.ts";

const identity = (text: string) => text;
const theme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

test("unfinished display math cannot consume following Markdown tables", () => {
	for (const open of ["$$", "\\["]) {
		const source = `${open}\nx^2\n\n| Name | Result |\n| --- | --- |\n| Reader | Ready |`;
		const text = new Markdown(source, 0, 0, theme).render(70).map(stripTerminalSequences).join("\n");
		expect(text).toContain("Reader");
		expect(text).toContain("Ready");
		expect(text).not.toContain("| --- | --- |");
	}
});

test("process exit restores keyboard, paste and alternate-screen modes without stop", () => {
	const run = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { ProcessTerminal } from './packages/tui/src/terminal.ts';
		import { TuiAltScreen } from './packages/tui/src/tui-alt-screen.ts';
		const tui = new TuiAltScreen(new ProcessTerminal(), false);
		tui.start();
		process.exit(0);
	`,
		],
		{ encoding: "utf8" },
	);
	expect(run.status, run.stderr).toBe(0);
	expect(run.stdout).toContain("\x1b[?2004l");
	expect(run.stdout).toContain("\x1b[<u");
	expect(run.stdout.lastIndexOf("\x1b[<u")).toBeLessThan(run.stdout.lastIndexOf("\x1b[?1049l"));
	expect(run.stdout).toContain("\x1b[?1006l");
});

test("Rex terminals expose their supported Kitty image transport", () => {
	const before = process.env.TERM_PROGRAM;
	try {
		process.env.TERM_PROGRAM = "rex";
		resetCapabilitiesCache();
		expect(getCapabilities().images).toBe("kitty");
	} finally {
		if (before === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = before;
		resetCapabilitiesCache();
	}
});
