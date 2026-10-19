import type { Context, Draft } from "@axi/chord";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions } from "@axi/ai";
import { calculateContextTokens, estimateMessageTokens } from "@axi/ai/utils/estimate";
import { isRetryableAssistantError, retryDelayMs } from "@axi/ai/utils/retry";
import { CompactionEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryDraft,
	EntryId,
	NextTaskState,
	RunningTask,
	TaskId,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { orderToolResults } from "./context.ts";
import {
	addCompactionStatus,
	compactionStatus,
	failCompactionStatus,
	LiveDoc,
	type LiveState,
	removeCompactionStatus,
} from "./live.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { admitSubmission } from "./submissions.ts";
import type {
	CompactionHooks,
	CompactionPolicy,
	CompactionReason,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	ModelRef,
	Settings,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

export type CompactionInput = { reason: CompactionReason; instructions?: string };
export type SummaryRequest = {
	attempt: number;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	streamOptions: ConversationStreamOptions;
	maxTokens: number;
	tail: EntryId;
	firstKept: EntryId;
};
export type CompactionCheckpoint =
	| { phase: "select" }
	| ({ phase: "summarize" } & SummaryRequest)
	| ({ phase: "retry"; until: number } & SummaryRequest);
type Runtime = TaskRuntime<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>;
type Next = NextTaskState<CompactionCheckpoint, CompactionResult>;
const systemPrompt = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const summaryPrompt = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const CompactionTask = defineTask<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>({
	name: "axi.compaction",
	version: 1,
	initial: () => ({ phase: "select" }),
	phases: {
		select: async (task, runtime, context) => {
			const agent = await runtime.agent(context),
				settings = runtime.settings,
				ref = agent.model;
			const model = ref === undefined ? undefined : runtime.models.getModel(ref.provider, ref.modelId);
			if (ref === undefined || model === undefined) return noModel(runtime, ref, context);
			const policy = compactionPolicy(settings, ref),
				view = await runtime.context(runtime.conversationId, context),
				cut = selectCut(view, policy.keepRecentTokens);
			if (cut === undefined) return complete(runtime, context);
			const firstKept = view.entries[cut]!.id;
			const input = {
				reason: task.input.reason,
				entries: view.entries.slice(0, cut),
				messages: summarizedMessages(view, cut),
				firstKept,
				...(task.input.instructions === undefined ? {} : { instructions: task.input.instructions }),
			};
			let decision: { readonly decline: true } | { readonly summary: string } | undefined;
			await runtime.hooks.each("beforeCompact", async (hook) => {
				if (decision === undefined) decision = await hook(input, runtime, context);
			});
			if (decision !== undefined && "decline" in decision) return complete(runtime, context);
			if (decision !== undefined) {
				const summary = decision.summary;
				return runtime.commit(
					async (tx, current) =>
						placeSummary(tx, runtime, current, await tx.doc(LiveDoc, runtime.conversationId), firstKept, summary),
					context,
				);
			}
			const request: SummaryRequest = {
				attempt: 1,
				model: ref,
				thinkingLevel: agent.thinkingLevel,
				streamOptions: settings.stream,
				maxTokens: Math.min(Math.floor(0.8 * policy.reserveTokens), model.maxTokens > 0 ? model.maxTokens : Infinity),
				tail: view.entries.reduce((tail, entry) => (entry.id > tail ? entry.id : tail), firstKept),
				firstKept,
			};
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "summarize", ...request } }), context);
		},
		summarize: async (task, runtime, context) => {
			const { phase: _, ...request } = task.state.checkpoint,
				{ model: ref, thinkingLevel, streamOptions, maxTokens, tail, firstKept, attempt } = request;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return noModel(runtime, ref, context);
			const view = await runtime.context(runtime.conversationId, context, { at: tail }),
				cut = view.entries.findIndex((entry) => entry.id === firstKept),
				now = runtime.now();
			const messages: Message[] = [
				{ role: "system", content: systemPrompt, timestamp: now },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `<conversation>\n${serializeConversation(summarizedMessages(view, cut))}\n</conversation>\n\n${summaryPrompt}${task.input.instructions === undefined ? "" : `\n\nAdditional focus: ${task.input.instructions}`}`,
						},
					],
					timestamp: now,
				},
			];
			const { deferred: _deferred, ...forwarded } = streamOptions;
			const options: SimpleStreamOptions = {
				...forwarded,
				cacheRetention: "none",
				maxTokens,
				signal: runtime.signal,
				telemetry: context.telemetry,
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await runtime.models.completeSimple(model, { messages }, options);
			runtime.signal.throwIfAborted();
			const summary = summaryText(message),
				policy = runtime.settings.retry;
			const retry =
				message.stopReason === "error" &&
				isRetryableAssistantError(message) &&
				policy.enabled &&
				attempt <= policy.maxRetries;
			const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
			await runtime.commit(async (tx, current): Promise<Next> => {
				await recordUsage(tx, runtime.conversationId, "models", `${message.provider}/${message.model}`, message.usage);
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				if (summary !== undefined) return placeSummary(tx, runtime, current, live, firstKept, summary);
				if (retry) {
					const status = compactionStatus(live, runtime.taskId);
					if (status) status.retry = { at: until, error: message.errorMessage ?? "" };
					return { status: "sleeping", checkpoint: { phase: "retry", ...request, until }, until };
				}
				const text = summaryFailure(message);
				failCompactionStatus(live, runtime.taskId, text);
				return {
					status: "terminal",
					outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
				};
			}, context);
		},
		retry: async (task, runtime, context) => {
			const { phase: _, until, ...request } = task.state.checkpoint;
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			const attempt = request.attempt + 1;
			await runtime.commit(async (tx) => {
				const status = compactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (status) {
					status.attempt = attempt;
					delete status.retry;
				}
				return { status: "running", checkpoint: { phase: "summarize", ...request, attempt } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(async (tx) => {
			removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

export async function createCompaction(
	tx: Tx,
	id: ConversationId,
	input: CompactionInput,
	owner?: TaskId,
): Promise<TaskId<CompactionResult>> {
	const taskId = await tx.createTask(CompactionTask, input, {
		ownership: owner === undefined ? { kind: "conversation" } : { kind: "task", taskId: owner },
		conversationId: id,
		background: owner === undefined && input.reason !== "manual",
	});
	addCompactionStatus(await tx.doc(LiveDoc, id), {
		taskId,
		reason: input.reason,
		blocking: owner !== undefined,
		attempt: 1,
	});
	return taskId;
}
export function compactionPolicy(settings: Settings, model: ModelRef): CompactionPolicy {
	const { modelOverrides, ...policy } = settings.compaction,
		override = modelOverrides?.[`${model.provider}/${model.modelId}`];
	return {
		enabled: override?.enabled ?? policy.enabled,
		reserveTokens: override?.reserveTokens ?? policy.reserveTokens,
		keepRecentTokens: override?.keepRecentTokens ?? policy.keepRecentTokens,
		backgroundTokens: override?.backgroundTokens ?? policy.backgroundTokens,
	};
}
function candidate(contributions: ContextView["contributions"], at: number): boolean {
	if (contributions[at]?.[0]?.role === "assistant") return true;
	if (contributions[at]?.[0]?.role !== "user") return false;
	let calls: Set<string> = new Set();
	for (let before = at - 1; before >= 0; before--) {
		const message = contributions[before]!.findLast((item) => item.role === "assistant");
		if (message === undefined) continue;
		calls = new Set(message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])));
		break;
	}
	if (!calls.size) return true;
	for (let after = at; after < contributions.length; after++)
		for (const [position, message] of contributions[after]!.entries()) {
			if (message.role === "assistant" && (after > at || position > 0)) return true;
			if (message.role === "toolResult" && calls.has(message.toolCallId)) return false;
		}
	return true;
}
export function selectCut(view: ContextView, keepRecentTokens: number): number | undefined {
	const from = view.head === undefined ? 0 : 1,
		candidates: number[] = [];
	for (let at = from; at < view.contributions.length; at++) if (candidate(view.contributions, at)) candidates.push(at);
	let tokens = 0;
	for (let at = view.contributions.length - 1; at >= from; at--) {
		for (const message of view.contributions[at]!) tokens += estimateMessageTokens(message);
		if (tokens < keepRecentTokens) continue;
		const cut = candidates.find((value) => value >= at) ?? candidates.at(-1);
		return cut !== undefined && view.contributions.slice(from, cut).some((messages) => messages.length > 0)
			? cut
			: undefined;
	}
}
export function summarizedMessages(view: ContextView, cut: number): Message[] {
	return orderToolResults(view.contributions.slice(0, cut).flat());
}
export function estimateContext(view: ContextView, extra: readonly Message[]): number {
	let measured: AssistantMessage | undefined;
	for (let at = view.entries.length - 1; at >= 0 && measured === undefined; at--)
		if (view.entries[at]!.id > (view.head?.id ?? -Infinity))
			measured = view.contributions[at]!.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && calculateContextTokens(message.usage) > 0,
			);
	let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage);
	for (const message of view.messages.slice(measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1))
		tokens += estimateMessageTokens(message);
	for (const message of extra) tokens += estimateMessageTokens(message);
	return tokens;
}
function text(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
}
export function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const value = text(message.content);
			if (value) parts.push(`[User]: ${value}`);
		} else if (message.role === "assistant") {
			const texts = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				calls = message.content.flatMap((part) =>
					part.type === "toolCall"
						? [
								`${part.name}(${Object.entries(part.arguments)
									.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
									.join(", ")})`,
							]
						: [],
				);
			if (texts.length) parts.push(`[Assistant]: ${texts.join("\n")}`);
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const value = text(message.content);
			if (value)
				parts.push(
					`[Tool result]: ${value.length > 2000 ? `${value.slice(0, 2000)}\n\n[... ${value.length - 2000} more characters truncated]` : value}`,
				);
		}
	}
	return parts.join("\n\n");
}
function summaryText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) return;
	const value = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
	return value || undefined;
}
function summaryFailure(message: AssistantMessage): string {
	if (message.stopReason === "error" || message.stopReason === "aborted")
		return `Summarization failed: ${message.errorMessage ?? message.stopReason}`;
	if (message.stopReason === "length") return "Summarization hit the token limit; the summary is incomplete";
	return message.content.some((part) => part.type === "toolCall")
		? "Summarization attempted to call a tool"
		: "Summarization produced no text";
}
async function placeSummary(
	tx: Tx,
	runtime: Runtime,
	task: RunningTask<CompactionInput, CompactionCheckpoint, CompactionResult>,
	live: Draft<LiveState>,
	firstKept: EntryId,
	summary: string,
): Promise<Next> {
	removeCompactionStatus(live, runtime.taskId);
	delete live.compactionFailure;
	const entry: EntryDraft = {
		kind: CompactionEntry.kind,
		head: firstKept,
		model: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
					},
				],
				timestamp: runtime.now(),
			},
		],
		data: { reason: task.input.reason },
	};
	const result: CompactionResult =
		task.owner === undefined
			? {
					submissionId: (
						await admitSubmission(
							tx,
							runtime.conversationId,
							{ type: "write", requestId: `compaction:${runtime.taskId}`, entry },
							runtime.now(),
							runtime.settings,
						)
					).id,
				}
			: { entryId: (await tx.appendEntry(runtime.conversationId, entry)).id };
	return { status: "terminal", outcome: { status: "completed", result } };
}
async function complete(runtime: Runtime, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
		return { status: "terminal", outcome: { status: "completed", result: {} } };
	}, context);
}
async function noModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		failCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId, message);
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}
