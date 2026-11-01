import { expect, it } from "vitest";
import { rankDocuments, tokenize } from "../src/search.ts";

it("ranks singular and camel-case terms and retains input order for ties", () => {
	expect(tokenize("findHTTPRequests categories searches")).toEqual(["find", "http", "request", "category", "search"]);
	const documents = [
		{ name: "issue", text: "Get a GitHub issue by number" },
		{ name: "repos", text: "List repositories of a user" },
		{ name: "same", text: "Get a GitHub issue by number" },
	];
	expect(rankDocuments("issues", documents, 8)).toEqual(["issue", "same"]);
	expect(rankDocuments("repositories", documents, 1)).toEqual(["repos"]);
	expect(rankDocuments("the and", documents, 8)).toEqual([]);
});

it("prioritizes complete names and term coverage over repeated description matches", () => {
	const documents = [
		{ name: "mcp__mail__queue_read", text: "Read a queued note from a thread. thread read thread read" },
		{ name: "mcp__inbox__thread_read", text: "Retrieve a complete discussion and its saved history." },
		{ name: "mcp__display__window", text: "Move or close an application window." },
		{ name: "mcp__display__capture", text: "Capture a screenshot of a window." },
	];
	for (const query of ["thread_read", "inbox__thread_read", "MCP__INBOX__THREAD_READ"])
		expect(rankDocuments(query, documents, 1)).toEqual(["mcp__inbox__thread_read"]);
	expect(rankDocuments("screenshot window", documents, 1)).toEqual(["mcp__display__capture"]);
	expect(rankDocuments("read", documents, 1)).toEqual(["mcp__mail__queue_read"]);
});

it.each([
	["搜索报告", ["搜索", "报告"]],
	["résumé cafe\u0301", ["résumé", "café"]],
	["ค้นหาไฟล์", ["ค้นหา", "ไฟล์"]],
	["Поиск файлов", ["поиск", "файлов"]],
])("preserves word boundaries and canonical Unicode spelling in %s", (query, expected) => {
	expect(tokenize(query)).toEqual(expected);
	expect(rankDocuments(query, [{ name: "localized", text: query.normalize("NFC") }], 1)).toEqual(["localized"]);
});

it("searches namespace instructions without penalizing a long shared namespace", () => {
	const documents = [
		{ name: "fetch", text: "Fetch a record.", namespaceText: `Archive reports. ${"storage ".repeat(200)}` },
		{ name: "remove", text: "Remove a record.", namespaceText: "Delete temporary records." },
	];
	expect(rankDocuments("reports", documents, 1)).toEqual(["fetch"]);
	expect(rankDocuments("fetch", documents, 1)).toEqual(["fetch"]);
});
