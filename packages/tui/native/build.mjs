import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(process.arch)) {
	throw new Error(`Unsupported native target: ${platform}-${process.arch}`);
}
const headers =
	process.env.NODE_INCLUDE_DIR ??
	[
		"/usr/include/node",
		resolve(dirname(process.execPath), "../include/node"),
		join(dirname(process.execPath), "include/node"),
	].find((path) => existsSync(join(path, "node_api.h")));
if (!headers || !existsSync(join(headers, "node_api.h")))
	throw new Error("Set NODE_INCLUDE_DIR to the directory containing node_api.h.");
const output = join(root, platform, "prebuilds", `${platform}-${process.arch}`);
mkdirSync(output, { recursive: true });
let compiler = process.env.CC ?? "cc",
	args;
if (platform === "win32") {
	compiler = process.env.CC ?? "cl";
	const library = process.env.NODE_IMPORT_LIBRARY;
	if (!library || !existsSync(library))
		throw new Error("Set NODE_IMPORT_LIBRARY to node.lib for this Node architecture.");
	args = [
		"/nologo",
		"/LD",
		"/O2",
		"/W4",
		`/I${headers}`,
		join(root, platform, "src/win32-platform.c"),
		library,
		"user32.lib",
		"/link",
		`/OUT:${join(output, "win32-platform.node")}`,
	];
} else if (platform === "darwin") {
	compiler = process.env.CC ?? "clang";
	args = [
		"-Wall",
		"-Wextra",
		"-Werror",
		"-O2",
		"-shared",
		"-fPIC",
		"-fobjc-arc",
		`-I${headers}`,
		join(root, platform, "src/darwin-platform.m"),
		"-framework",
		"AppKit",
		"-framework",
		"CoreGraphics",
		"-undefined",
		"dynamic_lookup",
		"-o",
		join(output, "darwin-platform.node"),
	];
} else {
	args = [
		"-std=c11",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-O2",
		"-fPIC",
		"-shared",
		"-pthread",
		"-nostdlib",
		"-fno-stack-protector",
		"-Wl,--unresolved-symbols=ignore-all",
		"-Wl,--no-as-needed",
		`-I${headers}`,
		join(root, platform, "src/linux-platform-x11.c"),
		"-lxcb",
		"-Wl,-z,nodelete",
		...(process.arch === "arm64" ? ["-Wl,-z,max-page-size=65536"] : []),
		"-o",
		join(output, "linux-platform-x11.node"),
	];
}
const result = spawnSync(compiler, args, { stdio: "inherit", cwd: output });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
if (platform === "win32") {
	for (const file of ["win32-platform.obj", "win32-platform.lib", "win32-platform.exp"])
		rmSync(join(output, file), { force: true });
}
