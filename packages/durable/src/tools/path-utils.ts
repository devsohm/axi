import type { Context } from "@axi/chord";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

export async function resolveToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	return getOrThrow(await env.absolutePath(normalized.startsWith("@") ? normalized.slice(1) : normalized, context));
}

export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const absolute = await resolveToolPath(env, path, context);
	const candidates = new Set([
		absolute,
		absolute.replace(/ (AM|PM)\./gi, "\u202f$1."),
		absolute.normalize("NFD"),
		absolute.replace(/'/g, "\u2019"),
		absolute.normalize("NFD").replace(/'/g, "\u2019"),
	]);
	for (const candidate of candidates) if (getOrThrow(await env.exists(candidate, context))) return candidate;
	return absolute;
}
