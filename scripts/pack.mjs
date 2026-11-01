import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const label = `${platform}-${process.arch}`;
const destination = path.resolve(
	process.argv[2] ?? path.join(root, "release", `axi-toolkit-${manifest.version}-${label}`),
);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run pack.");
if (existsSync(destination) && readdirSync(destination).length)
	throw new Error(`Output directory is not empty: ${destination}`);
const binary = path.join(
	root,
	"packages/env/bin",
	`axi-env-${label}`,
	platform === "windows" ? "axi-env.exe" : "axi-env",
);
if (!existsSync(binary)) throw new Error("Build the native environment daemon before packing.");
const terminalPlatform = process.platform;
const terminalBinary = path.join(
	root,
	"packages/tui/native",
	terminalPlatform,
	"prebuilds",
	`${terminalPlatform}-${process.arch}`,
	`${terminalPlatform}-platform${terminalPlatform === "linux" ? "-x11" : ""}.node`,
);
if (!existsSync(terminalBinary)) throw new Error("Build the native terminal helper before packing.");
if (!existsSync(path.join(root, "LICENSE"))) throw new Error("The release license is missing.");
mkdirSync(path.join(destination, "packages"), { recursive: true });
const dependencies = {};
const checksums = [];
for (const workspace of manifest.workspaces) {
	const directory = path.join(root, workspace);
	const pkg = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
	if (pkg.version !== manifest.version) throw new Error(`Version mismatch: ${pkg.name}`);
	for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
		if (name.startsWith("@axi/") && version !== manifest.version)
			throw new Error(`Dependency version mismatch: ${name}`);
	}
	const result = spawnSync(
		process.execPath,
		[npm, "pack", directory, "--json", "--pack-destination", path.join(destination, "packages")],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	if (result.status !== 0) throw new Error(result.stderr || `Packing ${pkg.name} failed.`);
	const [packed] = JSON.parse(result.stdout);
	if (!packed.files.some((file) => file.path.startsWith("dist/")))
		throw new Error(`Compiled files are missing: ${pkg.name}`);
	if (packed.files.some((file) => /^(?:src|test|node_modules|daemon\/target)\//.test(file.path)))
		throw new Error(`Unexpected source or build files: ${pkg.name}`);
	if (!packed.files.some((file) => file.path === "LICENSE")) throw new Error(`Package license is missing: ${pkg.name}`);
	if (
		pkg.name === "@axi/tui" &&
		!packed.files.some((file) => file.path === path.relative(directory, terminalBinary).split(path.sep).join("/"))
	)
		throw new Error("The native terminal helper is missing from its package.");
	dependencies[pkg.name] = `file:./packages/${packed.filename}`;
	const filename = `packages/${packed.filename}`;
	checksums.push(
		`${createHash("sha256")
			.update(readFileSync(path.join(destination, filename)))
			.digest("hex")}  ${filename}`,
	);
}
writeFileSync(
	path.join(destination, "package.json"),
	JSON.stringify(
		{
			name: "axi-toolkit",
			version: manifest.version,
			private: true,
			license: manifest.license,
			type: "module",
			engines: manifest.engines,
			dependencies,
		},
		null,
		2,
	) + "\n",
);
copyFileSync(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
copyFileSync(path.join(root, "docs/install.md"), path.join(destination, "README.md"));
writeFileSync(
	path.join(destination, "release.json"),
	JSON.stringify(
		{
			version: manifest.version,
			nativeTargets: readdirSync(path.join(root, "packages/env/bin")).sort(),
			terminalTargets: ["linux", "darwin", "win32"]
				.flatMap((platform) => {
					const base = path.join(root, "packages/tui/native", platform, "prebuilds");
					return existsSync(base)
						? readdirSync(base).filter((target) =>
								existsSync(path.join(base, target, `${platform}-platform${platform === "linux" ? "-x11" : ""}.node`)),
							)
						: [];
				})
				.sort(),
		},
		null,
		2,
	) + "\n",
);
writeFileSync(path.join(destination, "SHA256SUMS"), checksums.sort().join("\n") + "\n");
console.log(destination);
