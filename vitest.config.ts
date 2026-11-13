import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import manifest from "./package.json" with { type: "json" };

const temporary = realpathSync(tmpdir());
if (process.platform === "win32") {
	process.env.TMP = temporary;
	process.env.TEMP = temporary;
}

export default defineConfig({
	plugins: [
		{
			name: "workspace-test-sources",
			enforce: "pre",
			resolveId(specifier) {
				if (!specifier.startsWith("@axi/")) return;
				const target = fileURLToPath(import.meta.resolve(specifier)).replaceAll("\\", "/");
				const source = target.replace(/\/dist\/(.*)\.js$/, "/src/$1.ts");
				if (source !== target && existsSync(source)) return source;
			},
		},
	],
	test: {
		globalSetup: ["packages/env/test/build-daemon.ts"],
		env: { TMPDIR: temporary, ...(process.platform === "win32" ? { TMP: temporary, TEMP: temporary } : {}) },
		include: [...manifest.workspaces.map((directory) => `${directory}/test/**/*.test.ts`), "test/*.test.ts"],
		coverage: {
			provider: "v8",
			include: manifest.workspaces.map((directory) => `${directory}/src/**/*.ts`),
			exclude: ["**/*.d.ts"],
			reporter: ["text", "json", "json-summary", "html"],
			reportsDirectory: "coverage",
			thresholds: { lines: 90, branches: 78, functions: 88, statements: 87 },
		},
	},
});
