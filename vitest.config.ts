import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			name: "workspace-test-sources",
			enforce: "pre",
			resolveId(specifier) {
				if (!specifier.startsWith("@axi/")) return;
				const target = fileURLToPath(import.meta.resolve(specifier));
				const source = target.replace(/\/dist\/(.*)\.js$/, "/src/$1.ts");
				if (source !== target && existsSync(source)) return source;
			},
		},
	],
	test: {
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			exclude: ["**/*.d.ts"],
			reporter: ["text", "json", "json-summary", "html"],
			reportsDirectory: "coverage",
			thresholds: { lines: 79, branches: 64, functions: 77, statements: 75 },
		},
	},
});
