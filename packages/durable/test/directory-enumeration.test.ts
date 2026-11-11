import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@axi/objects/context";
import { afterEach, expect, test, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

const boundary = vi.hoisted((): { afterEnumeration?: () => Promise<void>; beforeInspection?: () => void } => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		readdir: async (...args: Parameters<typeof fs.readdir>) => {
			const names = await fs.readdir(...args);
			const action = boundary.afterEnumeration;
			boundary.afterEnumeration = undefined;
			await action?.();
			return names;
		},
		lstat: async (...args: Parameters<typeof fs.lstat>) => {
			const action = boundary.beforeInspection;
			boundary.beforeInspection = undefined;
			action?.();
			return fs.lstat(...args);
		},
	};
});

const directories: string[] = [];
afterEach(async () => {
	boundary.afterEnumeration = undefined;
	boundary.beforeInspection = undefined;
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "axi-directory-"));
	directories.push(cwd);
	return { cwd, env: new NodeExecutionEnv({ cwd }) };
}

test("listing survives a sidecar being replaced after enumeration", async () => {
	const { cwd, env } = await fixture();
	await writeFile(join(cwd, "record.jsonl"), "kept");
	await writeFile(join(cwd, "sidecar.reclaim"), "new");
	boundary.afterEnumeration = () => rename(join(cwd, "sidecar.reclaim"), join(cwd, "sidecar.jsonl"));
	expect(getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT)).map((entry) => entry.name)).toEqual(["record.jsonl"]);
	expect(getOrThrow(await env.readTextFile("sidecar.jsonl", BACKGROUND_CONTEXT))).toBe("new");
});

test.runIf(process.platform === "linux")("listing omits a filename that cannot round-trip through UTF-8", async () => {
	const { cwd, env } = await fixture();
	await writeFile(join(cwd, "visible"), "kept");
	await writeFile(Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from([0xff])]), "not addressable as text");
	expect(getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT)).map((entry) => entry.name)).toEqual(["visible"]);
});

test("an inspection failure other than disappearance still fails the listing", async () => {
	const { cwd, env } = await fixture();
	await writeFile(join(cwd, "private"), "kept");
	boundary.beforeInspection = () => {
		throw Object.assign(new Error("Access denied"), { code: "EACCES", path: join(cwd, "private") });
	};
	expect(await env.listDir(".", BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "permission_denied", path: join(cwd, "private") },
	});
});

test("a missing directory remains an error", async () => {
	const { cwd, env } = await fixture();
	expect(await env.listDir("missing", BACKGROUND_CONTEXT)).toMatchObject({
		ok: false,
		error: { code: "not_found", path: join(cwd, "missing") },
	});
});
