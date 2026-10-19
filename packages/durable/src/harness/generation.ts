import type { TaskCreationOptions } from "../session/transaction.ts";
import { type Context, copyJson, type Draft, type JsonValue } from "@axi/chord";
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolCall,
} from "@axi/ai";
import { isContextOverflow } from "@axi/ai/utils/overflow";
import { isRetryableAssistantError, retryDelayMs } from "@axi/ai/utils/retry";
import { getCurrentTools } from "@axi/ai/utils/transcript";
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	TaskOutcome,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { addTools, sectionExtension } from "./agent.ts";
import { compactionPolicy, createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, type Boundary, prepareBoundary, withdrawQueuedInputs } from "./inbox.ts";
import { assignJson } from "./json.ts";
import { appendAssistant, convertPartial, endRun, LiveDoc, type LiveState, type ToolSlot } from "./live.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	AfterFailedRun,
	CompactionPolicy,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	ToolControl,
	UserInput,
} from "./types.ts";
import { optionalExtension } from "./util.ts";

export type GenerationInput = Record<string, never>;
export type GenerationCheckpoint =
	| { phase: "prepare"; attempt: number; compacted?: TaskId<CompactionResult>; overflow?: string; threshold?: true }
	| {
			phase: "request";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			streamOptions: ConversationStreamOptions;
			cutoff: EntryId;
	  }
	| { phase: "retry"; attempt: number; compacted?: TaskId<CompactionResult>; until: number }
	| {
			phase: "poll";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	| { phase: "tools"; assistant: EntryId; tools: TaskId<ToolTaskResult>[]; pending: string[] };
export type GenerationResult = { entryId: EntryId };
type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;
type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly cutoff: EntryId;
	readonly messages?: readonly Message[];
	readonly pollAt?: number;
};
type Failure = { readonly policy: AfterFailedRun; readonly boundary?: Boundary };

export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "axi.generation",
	version: 1,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		prepare: async (task, runtime, context) => {
			const agent = await runtime.agent(context),
				settings = runtime.settings,
				{ model, thinkingLevel } = agent;
			const resolved = model === undefined ? undefined : runtime.models.getModel(model.provider, model.modelId);
			if (model === undefined || resolved === undefined) return failNoModel(runtime, model, context);
			const { attempt, compacted, overflow, threshold } = task.state.checkpoint;
			if (compacted !== undefined && overflow !== undefined) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome?.status !== "completed" || outcome.result.entryId === undefined)
					return failModel(runtime, overflow, context);
			}
			if (compacted !== undefined && threshold) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome !== undefined && outcome.status !== "completed")
					return failModel(runtime, compactionFailure(outcome), context);
			}
			const view = await runtime.context(runtime.conversationId, context),
				shown = replaySections(view.messages);
			let env: ExecutionEnv | undefined;
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				runtime.report(error, { type: "host", callback: "env" });
			}
			const input: PromptInput = {
				conversationId: runtime.conversationId,
				agent,
				env,
				shown: Object.fromEntries(shown),
				read: runtime,
			};
			const desired = await renderSections(
				agent.sections,
				input,
				shown,
				(error, section) =>
					runtime.report(error, { type: "extension", ...optionalExtension(sectionExtension(agent, section.key)) }),
				context,
			);
			const entries = planSystemEntries(view, desired, agent.tools, runtime.now()),
				compact =
					compacted === undefined
						? thresholdCompaction(view, entries, resolved.contextWindow, compactionPolicy(settings, model))
						: undefined;
			if (compact === "blocking") {
				await runtime.commit(async (tx): Promise<Next> => {
					const child = await createCompaction(tx, runtime.conversationId, { reason: "threshold" }, runtime.taskId);
					return {
						status: "waiting",
						checkpoint: { phase: "prepare", attempt, compacted: child, threshold: true },
						on: [child],
						policy: "allSettled",
					};
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				let cutoff = (await tx.scanEntries({ conversationId: runtime.conversationId }, 1)).items[0]?.id;
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, runtime.conversationId, entry)).id;
				if (cutoff === undefined) throw new Error(`Conversation ${runtime.conversationId} has no entries to send`);
				if (compact === "background" && (await tx.doc(LiveDoc, runtime.conversationId)).compactions === undefined)
					await createCompaction(tx, runtime.conversationId, { reason: "threshold" });
				return {
					status: "running",
					checkpoint: {
						phase: "request",
						attempt,
						...(compacted === undefined ? {} : { compacted }),
						model,
						thinkingLevel,
						streamOptions: settings.stream,
						cutoff,
					},
				};
			}, context);
		},
		request: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				await convertPartial(tx, live, runtime.conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(runtime.conversationId, context, { at: cutoff });
			let messages = view.messages;
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const change = await hook({ messages }, runtime, context);
				if (change !== undefined) messages = change.messages;
			});
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				telemetry: context.telemetry,
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			await classify(
				runtime,
				{ attempt, compacted, model: ref, cutoff, messages: view.messages },
				await streamResponse(runtime, model, messages, options, attempt, context),
				context,
			);
		},
		retry: async (task, runtime, context) => {
			const { attempt, compacted, until } = task.state.checkpoint;
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				return {
					status: "running",
					checkpoint: { phase: "prepare", attempt: attempt + 1, ...(compacted === undefined ? {} : { compacted }) },
				};
			}, context);
		},
		poll: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, cutoff, handle, pollAt } = task.state.checkpoint;
			if (pollAt > runtime.now()) return runtime.sleepUntil(pollAt, task.state.checkpoint, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await classify(
				runtime,
				{ attempt, compacted, model: ref, cutoff, pollAt },
				await runtime.models.fetchDeferred(model, handle, { signal: runtime.signal, telemetry: context.telemetry }),
				context,
			);
		},
		tools: async (task, runtime, context) => {
			const { assistant, tools, pending } = task.state.checkpoint,
				[next, ...rest] = pending;
			if (next === undefined) return finishTools(runtime, assistant, tools, context);
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId),
					id = await createTool(tx, runtime, assistant, next);
				const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined);
				if (slot) slot.taskId = id;
				return {
					status: "waiting",
					checkpoint: { phase: "tools", assistant, tools: [...tools, id], pending: rest },
					on: [id],
					policy: "allSettled",
				};
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase === "poll") {
			const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
			if (model !== undefined)
				try {
					await runtime.models.cancelDeferred(model, checkpoint.handle, {
						signal: runtime.signal,
						telemetry: context.telemetry,
					});
				} catch (error) {
					runtime.report(error, { type: "host", callback: "models" });
				}
		}
		const calls =
			checkpoint.phase === "tools" ? await unstarted(runtime, checkpoint.assistant, checkpoint.pending, context) : [];
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, runtime.conversationId);
			await convertPartial(tx, live, runtime.conversationId);
			for (const call of calls)
				await appendToolResult(
					tx,
					runtime.conversationId,
					call,
					harnessError("aborted", `Tool ${call.name} was aborted`),
					{ timestamp: runtime.now() },
				);
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

async function unstarted(
	runtime: Runtime,
	assistant: EntryId,
	ids: readonly string[],
	context: Context,
): Promise<ToolCall[]> {
	const message = (await runtime.entry(AssistantEntry, assistant, context))?.model?.[0],
		calls = message?.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [];
	return ids.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1));
}
function createTool(tx: Tx, runtime: Runtime, assistant: EntryId, callId: string): Promise<TaskId<ToolTaskResult>> {
	return tx.createTask(
		ToolTask,
		{ kind: "model", assistant, callId },
		{ ownership: { kind: "task", taskId: runtime.taskId } },
	);
}
function thresholdCompaction(
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	contextWindow: number,
	policy: CompactionPolicy,
): "blocking" | "background" | undefined {
	if (!policy.enabled || contextWindow <= 0) return;
	const tokens = estimateContext(
			view,
			planned.flatMap((entry) => entry.model ?? []),
		),
		limit = contextWindow - policy.reserveTokens;
	const mode =
		tokens > limit
			? "blocking"
			: policy.backgroundTokens > 0 && tokens > limit - policy.backgroundTokens
				? "background"
				: undefined;
	return mode !== undefined && selectCut(view, policy.keepRecentTokens) !== undefined ? mode : undefined;
}
function compactionFailure(outcome: Exclude<TaskOutcome<CompactionResult>, { status: "completed" }>): string {
	switch (outcome.status) {
		case "failed":
		case "faulted":
			return `Compaction failed: ${outcome.error.message}`;
		case "orphaned":
			return `Compaction failed: ${outcome.reason}`;
		case "aborted":
			return "Compaction was aborted";
	}
}
async function failureBoundary(tx: Tx, runtime: Runtime): Promise<Failure> {
	const settings = runtime.settings;
	return settings.afterFailedRun === "continue"
		? { policy: "continue", boundary: await prepareBoundary(tx, runtime.conversationId, settings) }
		: { policy: settings.afterFailedRun };
}
async function endFailed(
	tx: Tx,
	runtime: Runtime,
	live: Draft<LiveState>,
	failure: Failure,
	settlement: SubmissionSettlement,
): Promise<void> {
	endRun(tx, live, runtime.taskId, settlement);
	if (failure.policy === "withdraw") await withdrawQueuedInputs(tx, runtime.conversationId, "run_failed");
	if (failure.boundary !== undefined) {
		const { users } = await applyBoundary(tx, failure.boundary, "final", runtime.now());
		if (users.length) await startRun(tx, runtime.conversationId, live, users);
	}
}
async function failModel(runtime: Runtime, message: string, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const failure = await failureBoundary(tx, runtime),
			live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailed(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: message });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "model_error" } } } };
	}, context);
}
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const failure = await failureBoundary(tx, runtime),
			live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailed(tx, runtime, live, failure, { status: "unanswered", reason: "no_model" });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	const interval = runtime.settings.progress.partialIntervalMs;
	let pending: AssistantMessage | undefined,
		timer: (() => void) | undefined,
		writing: Promise<void> | undefined,
		stopped = false;
	const flush = () => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		writing = (async () => {
			const message = copyJson(partial, { omitUndefinedProperties: true });
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.generation ??= { attempt };
				assignJson(live.generation as Draft<Record<string, JsonValue>>, "message", message);
				return undefined;
			}, context);
		})()
			.catch((error: unknown) => {
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				writing = undefined;
				if (pending !== undefined && !stopped) timer = runtime.setTimer(flush, interval);
			});
	};
	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0) continue;
			pending = event.partial;
			if (timer === undefined && writing === undefined) timer = runtime.setTimer(flush, interval);
		}
		return await events.result();
	} finally {
		stopped = true;
		timer?.();
		await writing;
	}
}
async function classify(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	runtime.signal.throwIfAborted();
	const { attempt, compacted, model, cutoff } = request;
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const pollAt = Math.max(
				runtime.now() + (message.deferred.pollAfterMs ?? 5000),
				request.pollAt === undefined ? -Infinity : request.pollAt + 1,
			),
			handle = message.deferred;
		await runtime.commit(async (tx): Promise<Next> => {
			(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt, deferred: { pollAt } };
			return {
				status: "sleeping",
				until: pollAt,
				checkpoint: {
					phase: "poll",
					attempt,
					...(compacted === undefined ? {} : { compacted }),
					model,
					cutoff,
					handle,
					pollAt,
				},
			};
		}, context);
		return;
	}
	await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));
	const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
	if (message.stopReason === "toolUse" && calls.length) return startTools(runtime, request, message, calls, context);
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse")
		return answer(runtime, message, context);
	const settings = runtime.settings,
		overflow = message.stopReason === "error" && isContextOverflow(message),
		policy = compactionPolicy(settings, model);
	if (
		overflow &&
		compacted === undefined &&
		policy.enabled &&
		selectCut(await runtime.context(runtime.conversationId, context, { at: cutoff }), policy.keepRecentTokens) !==
			undefined
	) {
		await runtime.commit(async (tx): Promise<Next> => {
			const live = await tx.doc(LiveDoc, runtime.conversationId);
			await appendAssistant(tx, runtime.conversationId, message);
			delete live.generation;
			const child = await createCompaction(tx, runtime.conversationId, { reason: "overflow" }, runtime.taskId);
			return {
				status: "waiting",
				checkpoint: {
					phase: "prepare",
					attempt,
					compacted: child,
					overflow: message.errorMessage ?? "Context overflow",
				},
				on: [child],
				policy: "allSettled",
			};
		}, context);
		return;
	}
	const retry =
			message.stopReason === "error" &&
			!overflow &&
			isRetryableAssistantError(message) &&
			settings.retry.enabled &&
			attempt <= settings.retry.maxRetries,
		until = retry ? runtime.now() + retryDelayMs(settings.retry, attempt) : 0;
	await runtime.commit(async (tx): Promise<Next> => {
		const failure = retry ? undefined : await failureBoundary(tx, runtime),
			live = await tx.doc(LiveDoc, runtime.conversationId);
		await appendAssistant(tx, runtime.conversationId, message);
		if (failure === undefined) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			return {
				status: "sleeping",
				until,
				checkpoint: { phase: "retry", attempt, ...(compacted === undefined ? {} : { compacted }), until },
			};
		}
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		await endFailed(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}
async function answer(runtime: Runtime, message: AssistantMessage, context: Context): Promise<void> {
	let continuation: UserInput | undefined;
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation === undefined) continuation = (await hook(message, runtime, context))?.continue;
	});
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId,
			boundary = await prepareBoundary(tx, id, runtime.settings),
			live = await tx.doc(LiveDoc, id),
			entry = await appendAssistant(tx, id, message);
		const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } },
			{ users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continuation !== undefined && !users.length && !reset) {
			await tx.appendEntry(UserEntry, id, {
				model: [{ role: "user", content: continuation, timestamp: runtime.now() }],
			});
			handOver(live, runtime.taskId, await newGeneration(tx, id));
			delete live.generation;
		} else {
			endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
			if (users.length) await startRun(tx, id, live, users);
		}
		return result;
	}, context);
}
async function startTools(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	const messages =
			request.messages ?? (await runtime.context(runtime.conversationId, context, { at: request.cutoff })).messages,
		offered = new Set(getCurrentTools(messages).map((tool) => tool.name)),
		tools = (await runtime.agent(context)).tools;
	const sequential =
		runtime.settings.toolExecution === "sequential" ||
		calls.some(
			(call) => offered.has(call.name) && tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
		);
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId,
			live = await tx.doc(LiveDoc, id),
			entry = await appendAssistant(tx, id, message),
			slots: ToolSlot[] = [],
			started: TaskId<ToolTaskResult>[] = [],
			pending: string[] = [];
		for (const call of calls) {
			if (!offered.has(call.name)) {
				const result = await appendToolResult(
					tx,
					id,
					call,
					harnessError("tool_unavailable", `Tool ${call.name} is not available`),
					{ timestamp: runtime.now() },
				);
				slots.push({ callId: call.id, name: call.name, status: "done", entry: result.id });
			} else if (sequential && started.length) {
				pending.push(call.id);
				slots.push({ callId: call.id, name: call.name, status: "pending" });
			} else {
				const taskId = await createTool(tx, runtime, entry.id, call.id);
				started.push(taskId);
				slots.push({ callId: call.id, name: call.name, taskId, status: "pending" });
			}
		}
		delete live.generation;
		live.tools = slots;
		return {
			status: "waiting",
			checkpoint: { phase: "tools", assistant: entry.id, tools: started, pending },
			on: started,
			policy: "allSettled",
		};
	}, context);
}
async function finishTools(
	runtime: Runtime,
	assistant: EntryId,
	tasks: readonly TaskId<ToolTaskResult>[],
	context: Context,
): Promise<void> {
	const outcomes = await runtime.outcomes(tasks, context),
		controls = new Map<TaskId, ToolControl | undefined>();
	tasks.forEach((id, at) => {
		const outcome = outcomes[at]!;
		controls.set(
			id,
			outcome.status === "completed" && outcome.result.kind !== "nested" ? outcome.result.control : undefined,
		);
	});
	const slots = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.tools ?? [];
	await runtime.hooks.each("afterTools", (hook) =>
		hook(
			assistant,
			slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry])),
			runtime,
			context,
		),
	);
	const terminate =
			slots.length > 0 &&
			slots.every((slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true),
		added = [...controls.values()].flatMap((control) => control?.addTools ?? []),
		handoff = [...controls.values()].findLast((control) => control?.handoff !== undefined)?.handoff;
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId,
			boundary = await prepareBoundary(tx, id, runtime.settings);
		if (added.length) await addTools(tx, id, added);
		const live = await tx.doc(LiveDoc, id),
			now = runtime.now();
		if (terminate || handoff !== undefined) {
			if (handoff !== undefined) {
				const entry = await tx.appendEntry(ResetEntry, id, {
					head: "self",
					model: [{ role: "user", content: handoff, timestamp: now }],
				});
				boundary.head = entry.id;
			}
			const { users } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length) await startRun(tx, id, live, users);
		} else {
			const { users, reset } = await applyBoundary(tx, boundary, "postTools", now);
			if (reset) {
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				if (users.length) await startRun(tx, id, live, users);
			} else {
				delete live.tools;
				delete live.nestedTools;
				if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
				handOver(live, runtime.taskId, await newGeneration(tx, id));
			}
		}
		return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } };
	}, context);
}
function newGeneration(
	tx: Tx,
	conversationId: ConversationId,
	creation: Pick<TaskCreationOptions, "submissionIds"> = {},
): Promise<TaskId<GenerationResult>> {
	return tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId, ...creation });
}
export async function startRun(
	tx: Tx,
	id: ConversationId,
	live: Draft<LiveState>,
	inputs: SubmissionId[],
): Promise<void> {
	live.run = { taskId: await newGeneration(tx, id, { submissionIds: inputs }), inputs };
}
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
export { convertPartial } from "./live.ts";
