import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function resolve(subpath: string) {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
			try { console.log(import.meta.resolve(process.argv[1])); }
			catch (error) { console.log(error.code); process.exitCode = 1; }
		`,
			`@axi/ai/${subpath}`,
		],
		{ encoding: "utf8" },
	);
}

it.each(["api/anthropic-request", "api/bedrock-client", "providers/builtin"])(
	"keeps %s private to the implementation",
	(subpath) => {
		const result = resolve(subpath);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED\n");
	},
);

it.each(["api/openai-responses", "providers/anthropic", "utils/json-parse"])(
	"keeps the public %s entry point available",
	(subpath) => {
		const result = resolve(subpath);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("/dist/");
	},
);
