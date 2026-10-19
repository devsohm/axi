import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads with a Node-like process shim without builtin module access", () => {
	const moduleUrl = new URL("../src/utils/user-agent.ts", import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const host = process;
globalThis.process = { versions: { node: "22.19.0" } };
const { getUserAgent } = await import(${JSON.stringify(moduleUrl)});
host.stdout.write(getUserAgent());`,
		],
		{ encoding: "utf8" },
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("axi (browser)");
});
