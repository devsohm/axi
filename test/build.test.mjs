import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

for (const fails of [false, true]) {
	test(`workspace build removes stale output and preserves its exit result (${fails})`, async () => {
		const root = await mkdtemp(join(tmpdir(), "axi-build-"));
		try {
			await mkdir(join(root, "scripts"));
			const script = new URL("../scripts/build.mjs", import.meta.url);
			await copyFile(script, join(root, "scripts/build.mjs"));
			await writeFile(join(root, "package.json"), JSON.stringify({
				private: true,
				workspaces: ["packages/one", "packages/two"],
				scripts: { build: manifest.scripts.build },
			}));
			for (const name of ["one", "two"]) {
				const directory = join(root, "packages", name);
				await mkdir(join(directory, "dist"), { recursive: true });
				await writeFile(join(directory, "dist/obsolete.js"), "export const obsolete = true;");
				await writeFile(join(directory, "keep.txt"), "source stays");
				await writeFile(join(directory, "package.json"), JSON.stringify({
					name: `build-${name}`,
					scripts: { build: "node build.mjs" },
				}));
				await writeFile(join(directory, "build.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/current.js", "export const current = true;");
if (process.env.BUILD_FIXTURE_FAIL === "1") process.exit(19);
`);
			}
			const command = run(process.execPath, [process.env.npm_execpath, "run", "build"], {
				cwd: root,
				env: { ...process.env, BUILD_FIXTURE_FAIL: fails ? "1" : "0" },
			});
			if (fails) await assert.rejects(command, error => Number.isInteger(error.code) && error.code > 0);
			else await command;
			for (const name of ["one", "two"]) {
				const directory = join(root, "packages", name);
				await assert.rejects(readFile(join(directory, "dist/obsolete.js")), { code: "ENOENT" });
				assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "source stays");
				if (!fails) assert.equal(await readFile(join(directory, "dist/current.js"), "utf8"), "export const current = true;");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
