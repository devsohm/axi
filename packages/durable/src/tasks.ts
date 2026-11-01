import type { Task, TaskDefinition } from "./types.ts";

export function defineTask<I, S extends { phase: string }, R, H extends object = object>(
	definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H> {
	return { definition };
}
