import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { build } from "esbuild";
import { mimeOf, type ServedFile } from "./served.ts";
export type BasePlatform = "browser" | "sandbox";
export type BaseBundle = {
	readonly hash: string;
	readonly script: string;
	readonly style: string | undefined;
	readonly files: ReadonlyMap<string, ServedFile>;
};
export async function buildBase(entry: string, platform: BasePlatform, prefix: string): Promise<BaseBundle> {
	const browser = platform === "browser";
	const { outputFiles } = await build({
		entryPoints: [entry],
		bundle: true,
		outdir: "/",
		entryNames: "base",
		assetNames: "assets/[name]-[hash]",
		publicPath: prefix,
		write: false,
		format: browser ? "iife" : "cjs",
		platform: browser ? "browser" : "node",
		target: browser ? "es2022" : "node22",
		minify: true,
		legalComments: "none",
		tsconfigRaw: "{}",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		logLevel: "silent",
	});
	const digest = createHash("sha256");
	for (const file of [...outputFiles].sort((a, b) => (a.path < b.path ? -1 : 1)))
		digest.update(file.path).update(file.contents);
	const hash = digest.digest("hex").slice(0, 16),
		files = new Map<string, ServedFile>();
	let script = "",
		style: string | undefined;
	for (const file of outputFiles) {
		const extension = extname(file.path),
			isEntry = basename(file.path) === `base${extension}`;
		const path = prefix + (isEntry ? `base.${hash}${extension}` : `assets/${basename(file.path)}`);
		files.set(path, { mime: mimeOf(file.path), bytes: file.contents });
		if (isEntry) {
			if (extension === ".js") script = path;
			else style = path;
		}
	}
	return { hash, files, script, style };
}
