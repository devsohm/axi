import { afterEach, expect, test, vi } from "vitest";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

const plain = (text: string) => text;
const theme: MarkdownTheme = {
	heading: plain,
	link: plain,
	linkUrl: plain,
	code: plain,
	codeBlock: plain,
	codeBlockBorder: plain,
	quote: plain,
	quoteBorder: plain,
	hr: plain,
	listBullet: plain,
	bold: plain,
	italic: plain,
	strikethrough: plain,
	underline: plain,
};
const render = (markdown: Markdown, width = 60) =>
	markdown.render(width).map((line) => stripTerminalSequences(line).trimEnd());
afterEach(resetCapabilitiesCache);

test("ordered and task lists retain explicit markers and remove comments inside nested quotes", () => {
	const source =
		"3) third\n9) ninth\n\n- [x] done\n- [ ] pending\n\n> <!-- hidden -->\n>\n> - nested\n>   - child\n\n<!-- tail -->";
	const result = render(new Markdown(source, 0, 0, theme, undefined, { preserveOrderedListMarkers: true }));
	expect(result).toContain("3) third");
	expect(result).toContain("9) ninth");
	expect(result).toContain("- [x] done");
	expect(result).toContain("- [ ] pending");
	expect(result).toContain("│ - nested");
	expect(result).toContain("│     - child");
	expect(result.join("\n")).not.toContain("hidden");
	expect(result.join("\n")).not.toContain("tail");
	expect(render(new Markdown("3) third\n9) ninth", 0, 0, theme))).toEqual(["3. third", "4. ninth"]);
});

test("links avoid duplicated URL labels and escapes can remain literal", () => {
	for (const hyperlinks of [false, true]) {
		setCapabilities({ images: null, trueColor: true, hyperlinks });
		const markdown = new Markdown(
			"[https://example.test](https://example.test) [a@example.test](mailto:a@example.test) [guide](https://example.test/guide)  \nnext \\*literal\\*",
			0,
			0,
			theme,
		);
		const result = render(markdown, 160).join("\n");
		expect(result).toContain(
			hyperlinks
				? "https://example.test a@example.test guide"
				: "https://example.test a@example.test guide (https://example.test/guide)",
		);
		if (hyperlinks) expect(markdown.render(160).join("")).toContain("\x1b]8;;https://example.test/guide\x1b\\");
		expect(result).not.toContain("a@example.test (mailto:");
		expect(result).toContain("next *literal*");
	}
	expect(render(new Markdown("\\*literal\\*", 0, 0, theme, undefined, { preserveBackslashEscapes: true }))).toEqual([
		"\\*literal\\*",
	]);
});

test("incomplete fences stay literal while completed code uses its highlighter across streamed updates", () => {
	let epoch = "old";
	const highlightCode = vi.fn((code: string) => [`${epoch}:${code}`]);
	const custom = { ...theme, highlightCode, codeBlockIndent: "> " };
	const fence = "```js\nrun();\n```",
		markdown = new Markdown(fence, 0, 0, custom);
	expect(render(markdown)).toContain("> old:run();");
	expect(render(markdown, 30)).toContain("> old:run();");
	expect(highlightCode).toHaveBeenCalledTimes(1);
	markdown.setText("Intro\n\n" + fence);
	expect(render(markdown)).toContain("> old:run();");
	expect(highlightCode).toHaveBeenCalledTimes(1);
	epoch = "new";
	markdown.invalidate();
	expect(render(markdown)).toContain("> new:run();");
	expect(highlightCode).toHaveBeenCalledTimes(2);
	for (const source of ["> ```\n> line\n> ``", "- item\n\n  ```\n  line\n  ``"]) {
		const lines = render(new Markdown(source, 0, 0, theme));
		expect(lines.join("\n")).toContain("line");
		expect(lines.some((line) => /(?:^| )``$/.test(line))).toBe(false);
	}
});

test("narrow tables wrap their cell contents without losing text or table-column syntax", () => {
	const word = "antidisestablishmentarianism";
	for (const width of [9, 17, 25, 40]) {
		const lines = render(new Markdown(`| Name |\n| --- |\n| ${word} |`, 0, 0, theme), width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const cells = lines.filter((line) => line.startsWith("│")).map((line) => line.slice(1, -1).trim());
		expect(cells[0]).toBe("Name");
		expect(cells.slice(1).join("")).toBe(word);
	}
	const aligned = render(
		new Markdown("| Left | Mid | Right |\n| :--- | :---: | ---: |\n| a | b | c |", 0, 0, theme),
		40,
	);
	expect(
		aligned
			.find((line) => line.includes(" a "))
			?.split("│")
			.slice(1, -1)
			.map((cell) => cell.trim()),
	).toEqual(["a", "b", "c"]);
});

test("default text styling and background cover padding and continue after nested styles", () => {
	const ansi = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
	const styled = {
		...theme,
		bold: ansi(1, 22),
		italic: ansi(3, 23),
		strikethrough: ansi(9, 29),
		underline: ansi(4, 24),
	};
	const markdown = new Markdown("**bold** *italic* ~~gone~~ [guide](https://example.test)\n\n---", 1, 1, styled, {
		color: ansi(31, 39),
		bgColor: ansi(44, 49),
		bold: true,
		italic: true,
		strikethrough: true,
		underline: true,
	});
	const lines = markdown.render(64);
	expect(render(markdown, 64)[1]).toBe(" bold italic gone guide (https://example.test)");
	for (const line of lines) {
		expect(visibleWidth(line)).toBe(64);
		expect(line).toContain("\x1b[44m");
	}
	markdown.setText(" \t\n");
	expect(markdown.render(64)).toEqual([]);
});
