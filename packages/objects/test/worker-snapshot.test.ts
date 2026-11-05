import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildWorkerBase } from "../src/node/workers/base.ts";

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
		expect([...base.inputs].sort()).toEqual([entry, value]);
		base.remove();
		expect(existsSync(restored)).toBe(false);
	} finally {
		base.remove();
		await rm(directory, { recursive: true, force: true });
	}
});
