import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { build } from "esbuild";
import { recordedSources, type BaseInputs } from "../plugins/base-inputs.ts";
import { ASSET_EXTENSIONS, mimeOf, type ServedFile } from "./served.ts";
export type BasePlatform = "browser" | "sandbox";
export type BaseResolution = { readonly conditions?: readonly string[]; readonly tsconfig?: string };
export type BaseBundle = {
	readonly hash: string;
	readonly script: string;
	readonly style: string | undefined;
	readonly files: ReadonlyMap<string, ServedFile>;
	readonly inputs: BaseInputs;
};
export async function buildBase(entry: string, platform: BasePlatform, prefix: string, resolution: BaseResolution): Promise<BaseBundle> {
	const browser = platform === "browser";
	const inputs = new Map<string, string>();
	const selected = resolution.conditions ?? processConditions(process.execArgv, process.env.NODE_OPTIONS);
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
		...(resolution.tsconfig === undefined ? { tsconfigRaw: "{}" } : { tsconfig: resolution.tsconfig }),
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		conditions: browser ? [...selected, "module"] : [...selected],
		loader: Object.fromEntries(ASSET_EXTENSIONS.map((extension) => [`.${extension}`, "file" as const])),
		plugins: [recordedSources(inputs)],
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
	return { hash, files, script, style, inputs };
}
export function conditionsOf(args: readonly string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (flag === "--conditions" || flag === "-C") {
			if (index + 1 < args.length) values.push(args[++index]!);
		} else if (flag.startsWith("--conditions=") || flag.startsWith("-C="))
			values.push(flag.slice(flag.indexOf("=") + 1));
	}
	return values;
}
export function processConditions(execArgv: readonly string[], nodeOptions: string | undefined): string[] {
	const tokens: string[] = [];
	let token: string | undefined, quote = false;
	const text = nodeOptions ?? "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === " " && !quote) {
			if (token !== undefined) tokens.push(token);
			token = undefined;
			continue;
		}
		token ??= "";
		if (char === '"') quote = !quote;
		else token += quote && char === "\\" && index + 1 < text.length ? text[++index]! : char;
	}
	if (token !== undefined) tokens.push(token);
	return conditionsOf([...tokens, ...execArgv]);
}
