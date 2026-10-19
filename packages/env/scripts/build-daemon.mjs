import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const triple = process.env.CARGO_BUILD_TARGET;
const targets = {
	"aarch64-linux-android": ["android", "arm64"],
	"x86_64-linux-android": ["android", "x64"],
	"aarch64-unknown-linux-gnu": ["linux", "arm64"],
	"x86_64-unknown-linux-gnu": ["linux", "x64"],
	"aarch64-apple-darwin": ["darwin", "arm64"],
	"x86_64-apple-darwin": ["darwin", "x64"],
	"aarch64-pc-windows-msvc": ["windows", "arm64"],
	"x86_64-pc-windows-msvc": ["windows", "x64"],
};
if (triple && !Object.hasOwn(targets, triple)) throw new Error(`Unsupported daemon target: ${triple}`);
const [platform, arch] = triple
	? targets[triple]
	: [process.platform === "win32" ? "windows" : process.platform, process.arch];
if (!["linux", "android", "darwin", "windows"].includes(platform) || !["x64", "arm64"].includes(arch))
	throw new Error(`Unsupported daemon platform: ${process.platform}-${process.arch}`);
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "daemon/target");
const build = spawnSync(
	"cargo",
	["build", "--release", "--locked", "--manifest-path", resolve(root, "daemon/Cargo.toml"), "--target-dir", target],
	{ cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const filename = platform === "windows" ? "axi-env.exe" : "axi-env";
const destination = resolve(root, "bin", `axi-env-${platform}-${arch}`);
mkdirSync(destination, { recursive: true });
copyFileSync(resolve(target, triple ?? "", "release", filename), resolve(destination, filename));
console.log(resolve(destination, filename));
