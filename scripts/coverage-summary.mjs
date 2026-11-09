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

const [mode, filter = "", requested = "50"] = process.argv.slice(2);
if (mode !== undefined && mode !== "--gaps") throw new Error("Expected --gaps [path filter] [limit].");
if (mode === "--gaps") {
	const limit = Number(requested);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Coverage gap limit must be a positive integer.");
	const coverage = JSON.parse(readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"));
	const gaps = new Map();
	for (const [filename, entry] of Object.entries(coverage)) {
		const file = path.relative(root, filename).replaceAll("\\", "/");
		if (!file.includes(filter)) continue;
		if (!summary[filename]) throw new Error(`Coverage details have no summary entry: ${file}`);
		const source = readFileSync(filename, "utf8").split(/\r?\n/);
		const add = (kind, location, fallback) => {
			const line = location?.start?.line || fallback?.start?.line || 0;
			gaps.set(`${file}:${line}:${kind}`, {
				file,
				line,
				kind,
				source: line ? (source[line - 1] ?? "").trim().slice(0, 120) : "<unmapped>",
			});
		};
		for (const [id, count] of Object.entries(entry.s)) if (count === 0) add("statement", entry.statementMap[id]);
		for (const [id, count] of Object.entries(entry.f))
			if (count === 0) add(`function ${entry.fnMap[id].name}`, entry.fnMap[id].decl);
		for (const [id, counts] of Object.entries(entry.b))
			for (const [index, count] of counts.entries())
				if (count === 0) add("branch", entry.branchMap[id].locations[index], entry.branchMap[id].loc);
	}
	const rows = [...gaps.values()].sort(
		(a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind),
	);
	console.log(`${rows.length} uncovered locations match ${JSON.stringify(filter)}. Showing at most ${limit}.`);
	console.table(rows.slice(0, limit));
}
