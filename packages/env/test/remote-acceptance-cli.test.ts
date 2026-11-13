import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { localDaemon } from "../src/index.ts";

test.skipIf(process.platform === "win32")(
	"the remote acceptance CLI executes through a file symlink and emits all results",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-acceptance-cli-"));
		try {
			const alias = join(directory, "acceptance.ts");
			await symlink(fileURLToPath(new URL("./remote-acceptance.ts", import.meta.url)), alias);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[alias, JSON.stringify([localDaemon()]), "/bin/sh"],
				{ timeout: 15000 },
			);
			expect(JSON.parse(stdout)).toMatchObject({
				bytes: 1700000,
				passed: [
					"large binary transfer",
					"UTF-8 shell output",
					"ordered process pipes",
					"command timeout",
					"filesystem watch",
					"PTY input and dimensions",
					"new connection reads saved files",
				],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	20000,
);
