import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { writeCatalog } from "../scripts/catalog-output.ts";
import { hydrateModelCatalog } from "../scripts/hydrate-model-catalog.ts";
import { createHash } from "node:crypto";
import { validateGeneratedModelData, validateModelDataDirectory } from "../scripts/model-data.ts";
import type { Model } from "../src/types.ts";

const roots: string[] = [];
const renameFailure = vi.hoisted(() => ({ destination: "", remaining: 0 }));
vi.mock("node:fs", async (original) => {
	const filesystem = await original<typeof import("node:fs")>();
	return {
		...filesystem,
		renameSync(from: string, to: string) {
			if (to === renameFailure.destination && renameFailure.remaining-- > 0) throw new Error("Fixture rename failure");
			return filesystem.renameSync(from, to);
		},
	};
});
afterEach(() => {
	renameFailure.destination = "";
	renameFailure.remaining = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "axi-catalog-output-"));
	roots.push(root);
	mkdirSync(join(root, "src/providers"), { recursive: true });
	writeFileSync(join(root, "src/models.generated.ts"), "export {};\n");
	copyFileSync(new URL("../src/model-catalog.ts", import.meta.url), join(root, "src/model-catalog.ts"));
	return root;
}
function model(id: string): Model<"fixture"> & { type: "chat" } {
	return {
		type: "chat",
		id,
		name: id,
		provider: "test",
		api: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}
function snapshot(root: string) {
	return Object.fromEntries(
		readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
			.filter((file) => /\.(ts|json)$/.test(file))
			.map((file) => [file, readFileSync(join(root, "src", file), "utf8")]),
	);
}
const options = { dataOnly: false, jsonOnly: false, pretty: false };
it("writes usable typed catalogs and retains the separate JSON export", async () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, { ...options, jsonOutputDir: join(root, "export") });
	expect(() => validateGeneratedModelData(root)).not.toThrow();
	const loaded = await import(pathToFileURL(join(root, "src/models.generated.ts")).href);
	expect(loaded.MODELS.test.first).toMatchObject({ id: "first", api: "fixture", provider: "test" });
	expect(JSON.parse(readFileSync(join(root, "export/models.all.json"), "utf8"))).toEqual({ test: [model("first")] });
});
it("rejects invalid replacements before changing the existing files", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	const previous = snapshot(root);
	expect(() => writeCatalog(root, { test: [{ ...model("second"), maxTokens: 0 }] }, options)).toThrow(
		"invalid maxTokens",
	);
	expect(snapshot(root)).toEqual(previous);
	expect(readdirSync(join(root, "src/providers")).some((name) => name.startsWith(".catalog-output-"))).toBe(false);
});
it("reports invalid manifest and model fields in a stable order", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	const data = join(root, "src/providers/data");
	const content = `${JSON.stringify({ fixture: { "chat:first": { ...model("wrong"), type: "invalid" } } })}\n`;
	writeFileSync(join(data, "test.json"), content);
	writeFileSync(
		join(data, ".manifest.json"),
		JSON.stringify({
			schemaVersion: 5,
			generatedAt: "invalid",
			structureHash: "invalid",
			files: { "test.json": createHash("sha256").update(content).digest("hex") },
		}),
	);
	expect(() => validateModelDataDirectory({ test: { "chat:first": "fixture" } }, data)).toThrow(
		"Invalid generated model data:\n" +
			"  - model data schema is 5, expected 6\n" +
			"  - model data manifest has an invalid generation timestamp\n" +
			"  - model data generation stamp does not match the generated catalog\n" +
			'  - test/first has id "wrong", expected "first"\n' +
			'  - test/first has type "invalid", expected "chat", "image", or "classifier"\n' +
			"  - test/chat:first has mismatched type/id identity",
	);
});
it("identifies the provider when hydration rejects a malformed catalog entry", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	const previous = snapshot(root);
	const input = join(root, "catalog.json");
	writeFileSync(input, JSON.stringify({ test: [{ type: "chat", id: "first" }] }));
	expect(() => hydrateModelCatalog(root, input)).toThrow("Model catalog has an invalid entry for provider test");
	expect(snapshot(root)).toEqual(previous);
});
it("updates values without rewriting types and removes obsolete generated shards on full generation", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	const types = readFileSync(join(root, "src/models.generated.ts"), "utf8");
	writeCatalog(root, { test: [{ ...model("first"), name: "Updated" }] }, { ...options, dataOnly: true });
	expect(readFileSync(join(root, "src/models.generated.ts"), "utf8")).toBe(types);
	const values = JSON.parse(readFileSync(join(root, "src/providers/data/test.json"), "utf8"));
	expect(values.fixture["chat:first"].name).toBe("Updated");
	writeFileSync(join(root, "src/providers/obsolete.models.ts"), "export {};\n");
	writeCatalog(root, { test: [model("second")] }, options);
	expect(readdirSync(join(root, "src/providers"))).not.toContain("obsolete.models.ts");
	expect(() => validateGeneratedModelData(root)).not.toThrow();
});
it("restores the previous catalog when activating a replacement fails", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	const previous = snapshot(root);
	renameFailure.destination = join(root, "src/providers/data");
	renameFailure.remaining = 1;
	expect(() => writeCatalog(root, { test: [model("second")] }, options)).toThrow("Fixture rename failure");
	expect(snapshot(root)).toEqual(previous);
});
it("keeps recoverable values if activation and restoration both fail", () => {
	const root = fixture();
	writeCatalog(root, { test: [model("first")] }, options);
	renameFailure.destination = join(root, "src/providers/data");
	renameFailure.remaining = 2;
	expect(() => writeCatalog(root, { test: [model("second")] }, options)).toThrow(AggregateError);
	const recovery = readdirSync(join(root, "src/providers")).find((name) => name.startsWith(".catalog-output-"));
	expect(recovery).toEqual(expect.any(String));
	if (!recovery) throw new Error("Missing recovery directory");
	const values = JSON.parse(readFileSync(join(root, "src/providers", recovery, "previous/test.json"), "utf8"));
	expect(values.fixture["chat:first"].id).toBe("first");
});
