import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const map = read("docs/test-coverage.json");
const workspaces = new Map(
	read("package.json").workspaces.map((directory) => [directory, read(join(directory, "package.json")).name]),
);
if (
	map.packages.length !== workspaces.size ||
	new Set(map.packages.map((pkg) => pkg.directory)).size !== workspaces.size
)
	throw new Error("The behavior map must list every workspace exactly once.");
for (const pkg of map.packages) {
	if (workspaces.get(pkg.directory) !== pkg.name || pkg.areas.length === 0)
		throw new Error(`Invalid behavior-map package: ${pkg.directory}`);
	for (const area of pkg.areas)
		if (area.tests.length === 0 || area.tests.some((file) => !file.startsWith(`${pkg.directory}/test/`)))
			throw new Error(`Behavior area needs owned package tests: ${pkg.name}: ${area.behavior}`);
}
const coverage = read("coverage/coverage-summary.json");
const results = read("coverage/test-results.json");
const files = new Map(results.testResults.map((file) => [relative(root, file.name).replaceAll("\\", "/"), file]));
const lines = [
	"# Owned test coverage",
	"",
	`${results.numPassedTests} passed; ${results.numFailedTests} failed; ${results.numPendingTests} skipped.`,
	"",
	map.description,
	"",
	"Execution coverage includes instrumented TypeScript in the parent, child processes, worker threads, browser and workerd. It does not prove complete behavior. Native code and type-only contracts require separate checks.",
	"",
];
const measured = Object.entries(coverage).filter(([file]) => file !== "total");
for (const pkg of map.packages)
	if (
		!measured.some(
			([file, metrics]) =>
				metrics.lines.covered > 0 && relative(root, file).replaceAll("\\", "/").startsWith(`${pkg.directory}/src/`),
		)
	)
		throw new Error(`No measured source execution for ${pkg.name}`);
lines.push(
	"## Remaining execution coverage",
	"",
	"| Metric | Exercised | Still uncovered | Total |",
	"| --- | --- | --- | --- |",
	...["lines", "branches", "functions", "statements"].map((key) => {
		const metric = coverage.total[key];
		return `| ${key} | ${metric.covered} | ${metric.total - metric.covered} | ${metric.total} |`;
	}),
	"",
	"### Modules with the most uncovered branches",
	"",
	"This list orders investigation work. It does not classify an uncovered branch as a defect.",
	"",
	"| Module | Uncovered branches | Uncovered lines |",
	"| --- | --- | --- |",
	...measured
		.sort(([, a], [, b]) => b.branches.total - b.branches.covered - (a.branches.total - a.branches.covered))
		.slice(0, 30)
		.map(
			([file, metrics]) =>
				`| ${relative(root, file).replaceAll("\\", "/")} | ${metrics.branches.total - metrics.branches.covered} | ${metrics.lines.total - metrics.lines.covered} |`,
		),
	"",
);
for (const pkg of map.packages) {
	lines.push(`## ${pkg.name}`, "", "| Behavior area | Result | Owned test files |", "| --- | --- | --- |");
	for (const area of pkg.areas) {
		for (const path of area.tests)
			if (!existsSync(join(root, path))) throw new Error(`Missing coverage-map test: ${path}`);
		const runs = area.tests.map((path) => files.get(path));
		const status = runs.some((run) => run?.status === "failed")
			? "failed"
			: runs.every((run) => run?.status === "passed" && run.assertionResults.some((test) => test.status === "passed"))
				? "passed"
				: "not run";
		lines.push(`| ${area.behavior} | ${status} | ${area.tests.map((path) => `\`${path}\``).join(", ")} |`);
	}
	const mapped = new Set(pkg.areas.flatMap((area) => area.tests));
	const additional = [...files].filter(([path]) => path.startsWith(pkg.directory + "/test/") && !mapped.has(path));
	if (additional.length) {
		lines.push(
			"",
			"### Additional owned regression tests",
			"",
			"| Test file | Result | Passing cases |",
			"| --- | --- | --- |",
		);
		for (const [path, run] of additional)
			lines.push(
				`| ${path} | ${run.status} | ${run.assertionResults.filter((test) => test.status === "passed").length} |`,
			);
	}
	lines.push(
		"",
		"### Source execution coverage",
		"",
		"| Source module | Lines exercised | Branches exercised |",
		"| --- | --- | --- |",
	);
	const modules = Object.entries(coverage).filter(
		([file]) =>
			file !== "total" &&
			relative(root, file)
				.replaceAll("\\", "/")
				.startsWith(pkg.directory + "/src/"),
	);
	for (const [file, metrics] of modules.sort(([a], [b]) => a.localeCompare(b))) {
		const show = (metric) =>
			metric.total ? `${metric.pct}% (${metric.covered}/${metric.total})` : "no executable code";
		lines.push(
			`| ${relative(root, file).replaceAll("\\", "/")} | ${show(metrics.lines)} | ${show(metrics.branches)} |`,
		);
	}
	lines.push("");
}
lines.push(
	"## Separate runtime checks",
	"",
	...map.separateChecks.map((check) => `- ${check.name}: \`${check.command}\``),
	"",
	"These checks are run by npm run verify. Their results are not inferred from the JavaScript test report.",
	"",
	"## Verification still required",
	"",
	...map.unverified.map((note) => `- ${note}`),
	"",
);
writeFileSync(join(root, "coverage/test-map.md"), lines.join("\n"));
console.log("Behavior areas and every measured source module: coverage/test-map.md");
