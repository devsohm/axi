import type { Context } from "@axi/chord";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

const tails = new Map<string, Promise<void>>();

async function canonical(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const result = await env.canonicalPath(path, context);
	if (result.ok) return result.value;
	if (result.error.code === "not_supported") return path;
	if (result.error.code !== "not_found") throw result.error;
	const parent = getOrThrow(await env.joinPath([path, ".."], context));
	if (parent === path || !path.startsWith(parent)) return path;
	const name = path.slice(parent.length + (/[\\/]$/.test(parent) ? 0 : 1));
	return getOrThrow(await env.joinPath([await canonical(env, parent, context), name], context));
}

export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	operation: () => Promise<T>,
	context: Context,
): Promise<T> {
	const absolute = getOrThrow(await env.absolutePath(path, context));
	const key = `${env.id}\0${await canonical(env, absolute, context)}`;
	const previous = tails.get(key) ?? Promise.resolve();
	const gate = Promise.withResolvers<void>();
	const tail = previous.then(() => gate.promise);
	tails.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		gate.resolve();
		if (tails.get(key) === tail) tails.delete(key);
	}
}
