import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run verify.");
function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
}
function script(name, ...args) {
	run(process.execPath, [npm, "run", name, ...args]);
}

script("build");
script("build:daemon", "--workspace", "@axi/env");
script("build:native", "--workspace", "@axi/tui");
script("check");
script("test:coverage");
run("cargo", ["test", "--locked", "--manifest-path", "packages/env/daemon/Cargo.toml"]);
script("test:native", "--workspace", "@axi/tui");
script("test:workers");
const directory = mkdtempSync(join(tmpdir(), "axi-verify-"));
try {
	script("pack", "--", directory);
	script("verify:packages", "--", directory);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
