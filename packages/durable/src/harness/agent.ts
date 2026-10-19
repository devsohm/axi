import { copyJson } from "@axi/chord";
import { defineDoc } from "../documents.ts";
import { documentRetention } from "../session/session.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	ProgressPolicy,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};
export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = { partialIntervalMs: 100, outputIntervalMs: 100 };
export const DEFAULT_RESTART_LIMIT = 5;
export const INSTRUCTIONS_KEY = "instructions";
export const AgentDoc = defineDoc<AgentState>({
	kind: "axi.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

export function resolveSettings(value: HarnessSettings | undefined): Settings {
	const extensions = value?.extensions;
	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...value?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...value?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...value?.compaction },
		progress: {
			partialIntervalMs: value?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
			outputIntervalMs: value?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
		},
		toolExecution: value?.toolExecution ?? "parallel",
		steeringMode: value?.steeringMode ?? "one-at-a-time",
		followUpMode: value?.followUpMode ?? "one-at-a-time",
		contextRetentionMs: value?.contextRetentionMs ?? 600000,
		documentRetentionMs: documentRetention(value?.documentRetentionMs),
		afterFailedRun: value?.afterFailedRun ?? "keep",
		restartLimit: resolvedRestartLimit(value?.restartLimit),
	};
}

function resolvedRestartLimit(limit: number | undefined): number {
	return typeof limit === "number" && limit >= 1 ? Math.floor(limit) : DEFAULT_RESTART_LIMIT;
}

const names = (items: readonly { readonly name: string }[]): string[] => items.map((item) => item.name);
function list<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

export async function configure(tx: Tx, id: ConversationId, change: AgentChange): Promise<void> {
	const state = await tx.doc(AgentDoc, id);
	if (change.model === null) delete state.model;
	else if (change.model !== undefined) state.model = { ...change.model };
	const thinkingLevel = change.thinkingLevel;
	if (thinkingLevel === null) delete state.thinkingLevel;
	else if (thinkingLevel !== undefined) state.thinkingLevel = thinkingLevel;
	const extensions = change.extensions;
	if (extensions === null) delete state.extensions;
	else if (extensions !== undefined) {
		state.extensions = list(extensions)
			? names(extensions)
			: {
					...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
					...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
				};
	}
	const tools = change.tools;
	if (tools === null) delete state.tools;
	else if (tools !== undefined) state.tools = list(tools) ? names(tools) : { remove: names(tools.remove) };
	const modelTools = change.modelTools;
	if (modelTools === null) delete state.modelTools;
	else if (modelTools !== undefined) {
		state.modelTools = list(modelTools)
			? names(modelTools)
			: {
					...(modelTools.remove === undefined ? {} : { remove: names(modelTools.remove) }),
					...(modelTools.add === undefined ? {} : { add: names(modelTools.add) }),
				};
	}
	const instructions = change.instructions;
	if (instructions === null) delete state.instructions;
	else if (instructions !== undefined) state.instructions = instructions;
	const cwd = change.cwd;
	if (cwd === null) delete state.cwd;
	else if (cwd !== undefined) state.cwd = cwd;
}

export async function addTools(tx: Tx, id: ConversationId, added: readonly string[]): Promise<void> {
	const state = await tx.doc(AgentDoc, id);
	if (Array.isArray(state.tools)) {
		for (const name of added) if (!state.tools.includes(name)) state.tools.push(name);
	} else if (state.tools?.remove.some((name) => added.includes(name))) {
		state.tools = { remove: state.tools.remove.filter((name) => !added.includes(name)) };
	}
	if (Array.isArray(state.modelTools)) {
		for (const name of added) if (!state.modelTools.includes(name)) state.modelTools.push(name);
	} else {
		const remove = state.modelTools?.remove?.filter((name) => !added.includes(name)) ?? [];
		const add = [...(state.modelTools?.add ?? [])];
		for (const name of added) if (!add.includes(name)) add.push(name);
		state.modelTools = {
			...(remove.length ? { remove } : {}),
			add,
		};
	}
}

export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.parent) return;
	const state = await tx.doc(AgentDoc, conversation.id);
	if (conversation.owner) Object.assign(state, copyJson(await tx.doc(AgentDoc, conversation.owner.conversationId)));
}

export function agentHooks(agent: Agent, task: string): { readonly extension: string; readonly handlers: object }[] {
	return agent.extensions.flatMap((extension) =>
		(extension.hooks ?? [])
			.filter((hook) => hook.task === task)
			.map((hook) => ({ extension: extension.name, handlers: hook.handlers })),
	);
}
export function sectionExtension(agent: Agent, key: string): string | undefined {
	let owner: string | undefined;
	for (const extension of agent.extensions)
		if (
			extension.sections?.some((section) => section.key === key) ||
			extension.wraps?.some((wrap) => "section" in wrap && wrap.section === key)
		)
			owner = extension.name;
	return owner;
}
export function toolExtension(agent: Agent, name: string): string | undefined {
	let owner: string | undefined;
	for (const extension of agent.extensions)
		if (
			extension.tools?.some((tool) => tool.name === name) ||
			extension.wraps?.some((wrap) => "tool" in wrap && wrap.tool === name)
		)
			owner = extension.name;
	return owner;
}

function choose<T extends { readonly name: string }>(
	items: readonly T[],
	filter: string[] | { remove: string[] } | undefined,
): T[] {
	if (Array.isArray(filter)) {
		const byName = new Map(items.map((item) => [item.name, item]));
		return [...new Set(filter)].flatMap((name) => {
			const item = byName.get(name);
			return item ? [item] : [];
		});
	}
	return filter === undefined ? [...items] : items.filter((item) => !filter.remove.includes(item.name));
}
function wrapped<T>(
	items: Map<string, T>,
	key: string,
	transform: (item: T) => T,
	name: (item: T) => string,
	report: (error: unknown) => void,
): void {
	const before = items.get(key);
	if (before === undefined) return;
	try {
		const after = transform(before);
		if (name(after) !== key) throw new Error(`Wrapper renamed ${key} to ${name(after)}`);
		items.set(key, after);
	} catch (error) {
		items.delete(key);
		report(error);
	}
}

export function resolveAgent<T extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<T>,
	settings: Settings,
	report: (error: unknown, extension: string) => void,
): Agent<T> {
	const selection = state?.extensions;
	const selected = Array.isArray(selection)
		? selection
		: [
				...(settings.extensions ?? snapshot.installed()).map((extension) => extension.name),
				...(selection?.add ?? []),
			].filter((name) => !selection?.remove?.includes(name));
	const extensions: Extension<T>[] = [...new Set(selected)].flatMap((name) => {
		const extension = snapshot.extension(name);
		return extension ? [extension] : [];
	});
	const tools = new Map<string, T>();
	const sections = new Map<string, PromptSection<T>>();
	for (const extension of extensions) {
		for (const tool of extension.tools ?? []) tools.set(tool.name, tool);
		for (const section of extension.sections ?? []) sections.set(section.key, section);
	}
	for (const extension of extensions)
		for (const wrap of extension.wraps ?? []) {
			const failed = (error: unknown) => report(error, extension.name);
			if ("tool" in wrap)
				wrapped(
					tools,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					failed,
				);
			else
				wrapped(
					sections,
					wrap.section,
					(section) => wrap.wrap(section),
					(section) => section.key,
					failed,
				);
		}
	const enabled = choose([...tools.values()], state?.tools);
	const model = enabled.filter((tool) => tool.callers === undefined || tool.callers.includes("model"));
	const filter = state?.modelTools;
	let offered: T[];
	if (Array.isArray(filter)) offered = choose(model, filter);
	else {
		const eligible = model.filter((tool) => !filter?.remove?.includes(tool.name));
		offered = [
			...eligible.filter((tool) => tool.deferred !== true),
			...choose(
				eligible.filter((tool) => tool.deferred === true),
				[...new Set(filter?.add ?? [])],
			),
		];
	}
	const instructions = state?.instructions;
	const renderedSections = [...sections.values()];
	if (instructions !== undefined) renderedSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });
	return {
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools: offered,
		callable: enabled.filter((tool) => tool.callers === undefined || tool.callers.includes("tools")),
		deferred: model.filter((tool) => tool.deferred === true && !offered.includes(tool)),
		sections: renderedSections,
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
	};
}
