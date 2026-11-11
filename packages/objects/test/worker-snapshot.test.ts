import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildWorkerBase } from "../src/node/workers/base.ts";
import { contentHash } from "../src/node/plugins/base-inputs.ts";

it("owns a named cache directory only after materializing its snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-worker-cache-")),
		cache = join(directory, "cache"),
		marker = join(cache, "existing.txt"),
		entry = join(directory, "worker.ts");
	await mkdir(cache);
	await writeFile(marker, "previous process");
	await writeFile(entry, "console.log('snapshot');");
	const unused = await buildWorkerBase(entry, [], cache);
	unused.remove();
	expect(await readFile(marker, "utf8")).toBe("previous process");
	const current = await buildWorkerBase(entry, [], cache);
	try {
		const file = current.file();
		expect(dirname(file)).toBe(cache);
		expect(existsSync(marker)).toBe(false);
		expect(execFileSync(process.execPath, [file], { encoding: "utf8" }).trim()).toBe("snapshot");
		if (process.platform !== "win32") {
			expect((await stat(cache)).mode & 0o777).toBe(0o700);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
		await rm(cache, { recursive: true });
		expect(current.file()).toBe(file);
	} finally {
		current.remove();
		await rm(directory, { recursive: true, force: true });
	}
});

it("keeps worker source maps in separate files and maps errors when explicitly enabled", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-worker-maps-")),
		entry = join(directory, "entry.ts");
	await writeFile(
		entry,
		'function fail(){throw new Error("mapped failure")}\ntry{fail()}catch(error){console.log(error.stack)}',
	);
	const base = await buildWorkerBase(entry, []);
	try {
		const file = base.file(),
			code = await readFile(file, "utf8");
		expect(code).not.toContain("data:application/json;base64");
		expect(code).toContain("sourceMappingURL=worker.mjs.map");
		expect(JSON.parse(await readFile(file + ".map", "utf8")).sourcesContent).toBeUndefined();
		expect(execFileSync(process.execPath, ["--enable-source-maps", file], { encoding: "utf8" })).toContain(
			"entry.ts:1:",
		);
		expect(execFileSync(process.execPath, [file], { encoding: "utf8" })).toContain("worker.mjs:");
	} finally {
		base.remove();
		await rm(directory, { recursive: true, force: true });
	}
});

it("loads a lazy snapshot only on demand and restores every chunk after cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-lazy-base-"));
	const entry = join(directory, "entry.ts"),
		lazy = join(directory, "lazy.ts");
	await writeFile(
		entry,
		'console.log("ready"); if (process.argv[2] === "load") console.log((await import("./lazy.ts")).value);',
	);
	await writeFile(lazy, 'console.log("loaded"); export const value = 42;');
	const base = await buildWorkerBase(entry, []);
	try {
		expect(execFileSync(process.execPath, [base.file()], { encoding: "utf8" }).trim()).toBe("ready");
		await writeFile(lazy, 'throw new Error("new source must not run");');
		const first = base.file();
		const chunks = (await readdir(dirname(first))).filter((name) => name !== "worker.mjs");
		expect(chunks.length).toBeGreaterThan(0);
		await rm(join(dirname(first), chunks[0]!));
		const recreated = base.file();
		expect(recreated).not.toBe(first);
		expect(execFileSync(process.execPath, [recreated, "load"], { encoding: "utf8" }).trim().split("\n")).toEqual([
			"ready",
			"loaded",
			"42",
		]);
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
