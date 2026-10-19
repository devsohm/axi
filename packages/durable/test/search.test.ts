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
