import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";

export type ScopedCss = { readonly css: string; readonly classes: Readonly<Record<string, string>> };
export async function scopeCssModule(plugin: string, directory: string, file: string, contents: string): Promise<ScopedCss> {
	const id = createHash("sha256").update(`${plugin}\0${relative(directory, file)}`).digest("hex").slice(0, 8);
	const filename = `objects_${id}_${basename(file, ".module.css").replace(/[^\w-]/g, "_")}.module.css`;
	const result = await build({
		stdin: { contents: `import classes from "scoped:${filename}";module.exports=classes;`, loader: "js" },
		bundle: true, write: false, outdir: "/", format: "cjs", minifyWhitespace: true, logLevel: "silent",
		plugins: [{ name: "objects-css", setup(compiler) {
			compiler.onResolve({ filter: /^scoped:/ }, ({ path }) => ({ path: `/${path.slice(7)}`, namespace: "scoped" }));
			compiler.onResolve({ filter: /.*/ }, (args) => args.kind === "url-token" || args.kind === "import-rule" ? { path: args.path, external: true } : undefined);
			compiler.onLoad({ filter: /.*/, namespace: "scoped" }, () => ({ contents, loader: "local-css" }));
		} }],
	});
	const module = { exports: {} as Record<string, string> };
	new Script(result.outputFiles.find(({ path }) => path.endsWith(".js"))!.text).runInNewContext({ module, exports: module.exports });
	return { css: result.outputFiles.find(({ path }) => path.endsWith(".css"))?.text ?? "", classes: { ...module.exports } };
}
