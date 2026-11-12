import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run build.");
const { workspaces } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// TypeScript does not remove output whose source file was deleted.
for (const workspace of workspaces) rmSync(join(root, workspace, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [npm, "run", "build", "--workspaces", "--if-present"], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
