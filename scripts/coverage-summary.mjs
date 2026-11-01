import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const summary = JSON.parse(readFileSync(path.join(root, "coverage/coverage-summary.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const metrics = ["lines", "branches", "functions"];
const packages = new Map(
	manifest.workspaces.map((directory) => [
		directory,
		{
			name: JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")).name,
			values: Object.fromEntries(metrics.map((metric) => [metric, { covered: 0, total: 0 }])),
		},
	]),
);
for (const [filename, values] of Object.entries(summary)) {
	if (filename === "total") continue;
	const parts = path.relative(root, filename).split(path.sep);
	const entry = packages.get(parts.slice(0, 2).join("/"));
	if (!entry) throw new Error(`Coverage file is outside the workspace list: ${filename}`);
	for (const metric of metrics) {
		entry.values[metric].covered += values[metric].covered;
		entry.values[metric].total += values[metric].total;
	}
}
console.table(
	[...packages.values()].map(({ name, values }) => ({
		package: name,
		...Object.fromEntries(
			metrics.map((metric) => [
				metric,
				values[metric].total
					? `${((100 * values[metric].covered) / values[metric].total).toFixed(1)}%`
					: "no measured code",
			]),
		),
	})),
);
