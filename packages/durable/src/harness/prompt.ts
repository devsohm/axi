import type { Context } from "@axi/chord";
import type { Message, SystemMessage, Tool, ToolReference } from "@axi/ai";
import { declarationsEqual, getCurrentTools, toToolDeclaration } from "@axi/ai/utils/transcript";
import { SystemEntry } from "../entries.ts";
import type { ContextEdit, TypedEntryDraft } from "../types.ts";
import type { ContextView, PromptInput, PromptSection, ToolRegistration } from "./types.ts";

export function replaySections(messages: readonly Message[]): Map<string, string> {
	const sections = new Map<string, string>();
	for (const message of messages)
		if (message.role === "system") {
			for (const [key, text] of Object.entries(message.sections ?? {})) {
				if (text === null) sections.delete(key);
				else sections.set(key, text);
			}
		}
	return sections;
}

export async function renderSections<T extends ToolRegistration>(
	sections: readonly PromptSection<T>[],
	input: PromptInput<T>,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown, section: PromptSection<T>) => void,
	context: Context,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const section of sections) {
		let text: string | undefined;
		try {
			text = await section.render(input, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			report(error, section);
			const previous = shown.get(section.key);
			if (previous !== undefined) result.set(section.key, previous);
			continue;
		}
		if (text !== undefined)
			result.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
	}
	return result;
}

type ToolPatch = { readonly toolsRemoved: ToolReference[]; readonly toolsAdded: Tool[] };
function entry(
	sections: Record<string, string | null> | undefined,
	tools: ToolPatch | undefined,
	timestamp: number,
): TypedEntryDraft<never> {
	const message: SystemMessage = {
		role: "system",
		content: "",
		...(sections === undefined ? {} : { sections }),
		...(tools?.toolsRemoved.length ? { toolsRemoved: tools.toolsRemoved } : {}),
		...(tools?.toolsAdded.length ? { toolsAdded: tools.toolsAdded } : {}),
		timestamp,
	};
	return { model: [message] };
}

export function planSystemEntries(
	view: ContextView,
	desired: ReadonlyMap<string, string>,
	tools: readonly Tool[],
	timestamp: number,
): TypedEntryDraft<never>[] {
	if (view.head !== undefined && !view.entries.some((item) => SystemEntry.is(item) && item.id > view.head!.id)) {
		const baseline = entry(
			Object.fromEntries(desired),
			{ toolsRemoved: [], toolsAdded: tools.map(toToolDeclaration) },
			timestamp,
		);
		const edits: ContextEdit[] = view.entries
			.filter((item) => SystemEntry.is(item))
			.map((item) => ({ target: item.id, action: "omit" }));
		return [edits.length ? { ...baseline, edits } : baseline];
	}
	const shown = replaySections(view.messages);
	const oldKeys = [...shown.keys()];
	const replayedKeys = [
		...oldKeys.filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	const keys = [...desired.keys()];
	const patches: Record<string, string | null>[] = [];
	if (replayedKeys.some((key, index) => key !== keys[index])) {
		patches.push(Object.fromEntries(oldKeys.map((key) => [key, null])), Object.fromEntries(desired));
	} else {
		const patch: Record<string, string | null> = {};
		for (const [key, text] of shown) if (desired.get(key) !== text) patch[key] = desired.get(key) ?? null;
		for (const [key, text] of desired) if (!shown.has(key)) patch[key] = text;
		if (Object.keys(patch).length) patches.push(patch);
	}
	const offered = getCurrentTools(view.messages);
	const desiredTools = new Map(tools.map((tool) => [tool.name, tool]));
	const retained = offered.filter((before) => {
		const after = desiredTools.get(before.name);
		return after !== undefined && declarationsEqual(before, after);
	});
	const retainedNames = new Set(retained.map((tool) => tool.name));
	const added = tools.filter((tool) => !retainedNames.has(tool.name));
	const reordered = [...retained, ...added].some((tool, index) => tool.name !== tools[index]?.name);
	const delta: ToolPatch = reordered
		? {
				toolsRemoved: offered.map((tool) => ({ name: tool.name })),
				toolsAdded: tools.map(toToolDeclaration),
			}
		: {
				toolsRemoved: offered.filter((tool) => !retainedNames.has(tool.name)).map((tool) => ({ name: tool.name })),
				toolsAdded: added.map(toToolDeclaration),
			};
	const changed = delta.toolsRemoved.length > 0 || delta.toolsAdded.length > 0;
	if (changed && !patches.length) return [entry(undefined, delta, timestamp)];
	return patches.map((patch, index) =>
		entry(patch, changed && index === patches.length - 1 ? delta : undefined, timestamp),
	);
}
