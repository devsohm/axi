import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

export type BaseInputs = ReadonlyMap<string, string>;

export function contentHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function readRecorded(path: string, inputs: Map<string, string>): Promise<Buffer> {
	const contents = await readFile(path);
	inputs.set(path, contentHash(contents));
	return contents;
}

export function recordedSources(inputs: Map<string, string>): Plugin {
	return {
		name: "axi-base-inputs",
		setup(build) {
			build.onLoad({ filter: /.*/ }, async ({ namespace, path }) =>
				namespace === "file" ? { loader: "default", contents: await readRecorded(path, inputs) } : undefined,
			);
		},
	};
}
