import type { JsonValue } from "@axi/objects/json";
import type { Task } from "../types.ts";
import type { TSchema } from "@axi/ai";
import type {
	AnyTask,
	Extension,
	HookRegistration,
	HooksOf,
	PromptSection,
	HookTask,
	ToolRegistration,
	Wrap,
} from "./types.ts";

export function defineExtension<T extends ToolRegistration = ToolRegistration>(extension: Extension<T>): Extension<T> {
	return extension;
}
export function defineTool<P extends TSchema, D extends JsonValue = JsonValue, C extends JsonValue = JsonValue>(
	tool: ToolRegistration<P, D, C>,
): ToolRegistration<P, D, C> {
	return tool;
}
export function section<T extends ToolRegistration = ToolRegistration>(
	key: string,
	render: PromptSection<T>["render"],
	options?: { readonly tag?: boolean },
): PromptSection<T> {
	return { key, render, ...(options?.tag === undefined ? {} : { tag: options.tag }) };
}
export function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration {
	return { task: task.definition.name, handlers };
}
export function wrapTool<T extends ToolRegistration>(tool: T, wrap: (tool: T) => T): Wrap<T> {
	return { tool: tool.name, wrap };
}
export function wrapSection<T extends ToolRegistration = ToolRegistration>(
	key: string,
	wrap: (section: PromptSection<T>) => PromptSection<T>,
): Wrap<T> {
	return { section: key, wrap };
}

export function hookTask<I extends JsonValue, S extends { phase: string }, R, H extends object>(
	task: Task<I, S, R, H>,
	input: I,
): HookTask {
	return { task, input };
}
