import { INSTRUCTIONS_KEY } from "./agent.ts";
import { CompactionTask } from "./compaction.ts";
import { GenerationTask } from "./generation.ts";
import { ToolTask } from "./tool.ts";
import type { AnyTask, Extension, Registry, RegistrySnapshot, ToolRegistration } from "./types.ts";

export const BUILTIN_TASKS: readonly AnyTask[] = [GenerationTask, ToolTask, CompactionTask];
const sectionKey = /^[a-z][a-z0-9_-]*$/;
function snapshot<T extends ToolRegistration>(extensions: readonly Extension<T>[]): RegistrySnapshot<T> {
	const byName = new Map(extensions.map((extension) => [extension.name, extension])),
		tasks = new Map(BUILTIN_TASKS.map((task) => [task.definition.name, task]));
	for (const extension of extensions)
		for (const task of extension.tasks ?? []) {
			const name = task.definition.name;
			if (tasks.has(name)) throw new Error(`Task ${name} of extension ${extension.name} is already installed`);
			tasks.set(name, task);
		}
	return {
		installed: () => extensions,
		extension: (name) => byName.get(name),
		tools: () => extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool }))),
		sections: () =>
			extensions.flatMap((extension) => (extension.sections ?? []).map((section) => ({ extension, section }))),
		tasks: () => [...tasks.values()],
		task: (name) => tasks.get(name),
	};
}
function validate(extension: Extension): void {
	const tools = new Set<string>();
	for (const tool of extension.tools ?? []) {
		if (tools.has(tool.name)) throw new Error(`Extension ${extension.name} has two tools named ${tool.name}`);
		tools.add(tool.name);
	}
	const sections = new Set<string>();
	for (const { key } of extension.sections ?? []) {
		if (!sectionKey.test(key)) throw new TypeError(`Section key ${JSON.stringify(key)} must match ${sectionKey}`);
		if (key === INSTRUCTIONS_KEY) throw new Error(`Section key ${key} is reserved for the agent's instructions`);
		if (sections.has(key)) throw new Error(`Extension ${extension.name} has two sections with key ${key}`);
		sections.add(key);
	}
}
export function createRegistry<T extends ToolRegistration = ToolRegistration>(): Registry<T> {
	let current = snapshot<T>([]);
	const listeners = new Set<() => void>();
	const publish = (extensions: readonly Extension<T>[]) => {
		current = snapshot(extensions);
		for (const listener of [...listeners]) listener();
	};
	return {
		snapshot: () => current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		install: (extension) => {
			validate(extension);
			const installed = current.installed();
			publish(
				installed.some((existing) => existing.name === extension.name)
					? installed.map((existing) => (existing.name === extension.name ? extension : existing))
					: [...installed, extension],
			);
		},
		uninstall: (extension) => {
			const installed = current.installed();
			if (installed.some((existing) => existing.name === extension.name))
				publish(installed.filter((existing) => existing.name !== extension.name));
		},
	};
}
