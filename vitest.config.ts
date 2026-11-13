import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";
import manifest from "./package.json" with { type: "json" };
import { typescriptSources } from "./scripts/coverage-provider.mjs";
import { workspaceSource } from "./scripts/coverage-instrument.ts";

const temporary = realpathSync(tmpdir());

export default defineConfig({
	esbuild: false,
	oxc: false,
	plugins: [
		typescriptSources,
		{
			name: "workspace-test-sources",
			enforce: "pre",
			resolveId: workspaceSource,
		},
	],
	test: {
		globalSetup: ["packages/env/test/build-daemon.ts"],
		env: { TMPDIR: temporary },
		include: [...manifest.workspaces.map((directory) => `${directory}/test/**/*.test.ts`), "test/*.test.ts"],
		coverage: {
			provider: "custom",
			customProviderModule: "./scripts/coverage-provider.mjs",
			include: manifest.workspaces.map((directory) => `${directory}/src/**/*.ts`),
			exclude: ["**/*.d.ts"],
			reporter: ["text", "json", "json-summary", "html"],
			reportsDirectory: "coverage",
			thresholds: { lines: 90, branches: 78, functions: 88, statements: 87 },
		},
	},
});
