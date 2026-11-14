import { expect, test } from "vitest";
import { mcpServerSummary } from "../src/index.ts";

test.each([
	{ description: "  Project index  \r\nExtra details", instructions: "Other text", expected: "Project index" },
	{ description: "\n\t \n", instructions: "\n  Search the web\r\nUsage details", expected: "Search the web" },
	{ description: "Single line", instructions: undefined, expected: "Single line" },
	{ description: undefined, instructions: " Instructions only ", expected: "Instructions only" },
	{ description: "\r\n", instructions: "\t", expected: "" },
	{ description: undefined, instructions: undefined, expected: "" },
])("server summary selects one trimmed line: $expected", ({ description, instructions, expected }) => {
	expect(mcpServerSummary(description, instructions)).toBe(expected);
});

test("server summaries preserve punctuation and Unicode without truncating the selected line", () => {
	const summary = "查询 — " + "é".repeat(120);
	expect(mcpServerSummary(`\n ${summary}\t\nSecond line`, "unused")).toBe(summary);
});
