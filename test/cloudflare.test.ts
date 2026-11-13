import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("./workers/run.mjs", import.meta.url));
const installed = existsSync(new URL("./workers/node_modules/miniflare", import.meta.url));

test.skipIf(process.platform === "win32" || !installed)(
	"workerd commits SQLite state, recovers a Durable agent and exchanges remote Code Mode calls",
	async () => {
		const result = await promisify(execFile)(process.execPath, [script], { timeout: 90000, maxBuffer: 1024 * 1024 });
		expect(JSON.parse(result.stdout)).toEqual({
			runtime: "workerd",
			requests: 2,
			agentRuns: ["done", "done"],
			remoteValues: [42, 42],
		});
	},
	100000,
);
