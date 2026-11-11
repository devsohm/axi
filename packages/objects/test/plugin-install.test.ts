import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { discoverPlugins, installDependencies, installPlugin, type PluginSource } from "../src/node/plugins/index.ts";

test("install errors identify the rejected input or command and leave the root unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "axi-plugin-install-"));
	try {
		for (const value of ["", "--option"]) {
			const sources: readonly [PluginSource, string][] = [
				[{ git: value, ref: "main" }, "repository"],
				[{ git: "https://example.invalid/plugin.git", ref: value }, "ref"],
				[{ npm: value, version: "1" }, "package"],
				[{ npm: "example-plugin", version: value }, "version"],
			];
			for (const [source, field] of sources)
				await expect(installPlugin(source, root, context)).rejects.toThrow(
					`installPlugin: ${field} "${value}" is refused`,
				);
		}
		const directory = join(root, "existing");
		await mkdir(directory);
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "existing" }));
		const {
			plugins: [plugin],
		} = await discoverPlugins([root], { kinds: [] }, context);
		await expect(installDependencies(plugin, context, { npmCommand: [] })).rejects.toThrow(/^npmCommand is empty$/);
		await expect(
			installPlugin({ npm: "example-plugin", version: "1" }, root, context, {
				npmCommand: [process.execPath, "-e", "process.stdout.write('[]')"],
			}),
		).rejects.toThrow(`${process.execPath} pack example-plugin@1: packed nothing`);
		expect(await readdir(root)).toEqual(["existing"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each(["array", "object"])("installs an archive from npm's %s pack result", async (format) => {
	const directory = await mkdtemp(join(tmpdir(), "axi-plugin-pack-"));
	const root = join(directory, "plugins"),
		payload = join(directory, "package"),
		archive = join(directory, "fixture.tgz"),
		command = join(directory, "npm.cjs");
	await mkdir(root);
	await mkdir(payload);
	await writeFile(join(payload, "package.json"), JSON.stringify({ name: "example-plugin", type: "module" }));
	await writeFile(join(payload, "worker.ts"), "export default {setup(){}};");
	execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
	await writeFile(
		command,
		`const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('pack')) {
 const destination=process.argv[process.argv.indexOf('--pack-destination')+1];
 fs.copyFileSync(${JSON.stringify(archive)},path.join(destination,'packed.tgz'));
 const item={filename:'packed.tgz'};
 process.stdout.write(JSON.stringify(${JSON.stringify(format)}==='array'?[item]:{'example-plugin':item}));
}`,
	);
	try {
		const plugins = await installPlugin({ npm: "example-plugin", version: "1" }, root, context, {
			kinds: ["worker"],
			npmCommand: [process.execPath, command],
		});
		expect(plugins).toEqual(["example-plugin"]);
		expect(await readFile(join(root, "example-plugin", "worker.ts"), "utf8")).toContain("setup");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
