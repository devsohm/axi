import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildWorkerBase } from "../src/node/workers/base.ts";
import { contentHash } from "../src/node/plugins/base-inputs.ts";

it("loads a lazy snapshot only on demand and restores every chunk after cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-lazy-base-"));
	const entry = join(directory, "entry.ts"), lazy = join(directory, "lazy.ts");
	await writeFile(entry, 'console.log("ready"); if (process.argv[2] === "load") console.log((await import("./lazy.ts")).value);');
	await writeFile(lazy, 'console.log("loaded"); export const value = 42;');
	const base = await buildWorkerBase(entry, []);
	try {
		expect(execFileSync(process.execPath, [base.file()], { encoding: "utf8" }).trim()).toBe("ready");
		await writeFile(lazy, 'throw new Error("new source must not run");');
		const first = base.file();
		const chunks = (await readdir(dirname(first))).filter(name => name !== "worker.mjs");
		expect(chunks.length).toBeGreaterThan(0);
		await rm(join(dirname(first), chunks[0]!));
		const recreated = base.file();
		expect(recreated).not.toBe(first);
		expect(execFileSync(process.execPath, [recreated, "load"], { encoding: "utf8" }).trim().split("\n")).toEqual(["ready", "loaded", "42"]);
	} finally {
		base.remove();
		await rm(directory, { recursive: true, force: true });
	}
});

it("keeps a worker snapshot and source location after edits and temporary-file cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-base-test-"));
	const entry = join(directory, "entry.ts"),
		value = join(directory, "value.ts");
	await writeFile(entry, 'import { value } from "./value.ts"; console.log(JSON.stringify([value, import.meta.url]));');
	await writeFile(value, "export const value = 17;");
	const base = await buildWorkerBase(entry, []);
	try {
		await writeFile(value, "export const value = 99;");
		const original = base.file();
		await rm(dirname(original), { recursive: true });
		const restored = base.file();
		expect(restored).not.toBe(original);
		expect(JSON.parse(execFileSync(process.execPath, [restored], { encoding: "utf8" }))).toEqual([
			17,
			pathToFileURL(entry).href,
		]);
		expect([...base.inputs.keys()].sort()).toEqual([entry, value]);
		expect(base.inputs.get(value)).toBe(contentHash(Buffer.from("export const value = 17;")));
		base.remove();
		expect(existsSync(restored)).toBe(false);
	} finally {
		base.remove();
		await rm(directory, { recursive: true, force: true });
	}
});
