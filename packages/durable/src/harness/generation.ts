import type { TaskCreationOptions } from "../session/transaction.ts";
import { type Context } from "@axi/objects/context";
import { copyJson, type JsonValue } from "@axi/objects/json";
import { type Draft } from "@axi/objects/delta";
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
	Task,
	TaskId,
	TaskOutcome,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { addTools, agentHooks, sectionExtension } from "./agent.ts";
import { compactionPolicy, createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, type Boundary, prepareBoundary, withdrawQueuedInputs } from "./inbox.ts";
import { PartialChanges, type PartialMessage } from "./partial-changes.ts";
import {
	cutOffTooOften,
	cutOffCount,
	salvageable,
	appendAssistant,
	convertPartial,
	endRun,
	LiveDoc,
	type LiveState,
	type RunEnd,
	type ToolSlot,
} from "./live.ts";
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
	RunSummary,
	RunEndTask,
	ToolControl,
	UserInput,
} from "./types.ts";
import { endedByCrashes } from "./scheduler.ts";
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
	| {
			phase: "retry";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			until: number;
			poll?: { model: ModelRef; thinkingLevel?: ModelThinkingLevel; cutoff: EntryId; handle: DeferredHandle };
	  }
	| {
			phase: "poll";
			thinkingLevel?: ModelThinkingLevel;
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	| { phase: "tools"; assistant: EntryId; tools: TaskId<ToolTaskResult>[]; pending: string[] }
	| { phase: "finish"; run: RunSummary }
	| { phase: "drain"; answer: EntryId; tasks: TaskId[] };
export type GenerationResult = { entryId: EntryId };
type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;
type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly cutoff: EntryId;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly messages?: readonly Message[];
	readonly pollAt?: number;
};
type Failure = { readonly policy: AfterFailedRun; readonly boundary?: Boundary };

export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "axi.generation",
	version: 2,
	migrate: (input, checkpoint) => ({ input: input as GenerationInput, checkpoint: checkpoint as GenerationCheckpoint }),
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		prepare: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
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
			const view = await runtime.context(runtime.conversationId, context);
			const last = view.messages.findLast((message) => message.role !== "system");
			if (last?.role !== "user" && last?.role !== "toolResult") return failNothingToAnswer(runtime, context);
			const shown = replaySections(view.messages);
			let env: ExecutionEnv | undefined;
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				runtime.report(error, { kind: "host", callback: "env" });
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
					runtime.report(error, { kind: "extension", ...optionalExtension(sectionExtension(agent, section.key)) }),
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
				let cutoff = await tx.latestEntryId(runtime.conversationId);
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
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			if ((task.restarts ?? 0) > 0) return interruptedRequest(runtime, task.state.checkpoint, context);
			const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			await runtime.commit(
				async (tx) => {
					const live = await tx.doc(LiveDoc, runtime.conversationId);
					await convertPartial(tx, live, runtime.conversationId);
					live.generation = { attempt };
					return undefined;
				},
				context,
				{ persistence: { kind: "deferred" } },
			);
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
				onPayload: async (payload) => {
					let body = payload;
					await runtime.hooks.each("beforeProviderRequest", async (hook) => {
						const replacement = await hook({ model, payload: body }, runtime, context);
						if (replacement !== undefined) body = replacement.payload;
					});
					return body;
				},
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			await classify(
				runtime,
				{ attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages },
				await streamResponse(runtime, model, messages, options, attempt, context),
				context,
			);
		},
		retry: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			const { attempt, compacted, until, poll } = task.state.checkpoint;
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				return {
					status: "running",
					checkpoint:
						poll === undefined
							? { phase: "prepare", attempt: attempt + 1, ...(compacted === undefined ? {} : { compacted }) }
							: {
									phase: "poll",
									...poll,
									attempt: attempt + 1,
									...(compacted === undefined ? {} : { compacted }),
									pollAt: until,
								},
				};
			}, context);
		},
		poll: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			if ((task.restarts ?? 0) > 0) return interruptedRequest(runtime, task.state.checkpoint, context);
			const { attempt, compacted, model: ref, thinkingLevel, cutoff, handle, pollAt } = task.state.checkpoint;
			if (pollAt > runtime.now()) return runtime.sleepUntil(pollAt, task.state.checkpoint, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt, deferred: { pollAt } };
			}, context);
			await classify(
				runtime,
				{ attempt, compacted, model: ref, thinkingLevel, cutoff, pollAt },
				await runtime.models.fetchDeferred(model, handle, { signal: runtime.signal, telemetry: context.telemetry }),
				context,
			);
		},
		tools: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			const { assistant, tools, pending } = task.state.checkpoint,
				[next, ...rest] = pending;
			if (next === undefined) return finishTools(runtime, assistant, tools, context);
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined);
				const id = await createTool(tx, runtime, assistant, next, slot?.unoffered);
				if (slot) slot.taskId = id;
				return {
					status: "waiting",
					checkpoint: { phase: "tools", assistant, tools: [...tools, id], pending: rest },
					on: [id],
					policy: "allSettled",
				};
			}, context);
		},
		finish: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return finishCutOff(runtime, task, task.state.checkpoint.run.answer, context);
			const run = task.state.checkpoint.run;
			const tasks: PreparedRunTask[] = [];
			await runtime.hooks.each("afterRun", async (hook) => {
				const requested = await hook(run, runtime, context);
				if (requested !== undefined) prepareRunTasks(runtime, requested.tasks, tasks);
			});
			if (!tasks.length) return finishAnswered(runtime, run.answer, context);
			await runtime.commit(async (tx): Promise<Next> => {
				const ids: TaskId[] = [];
				for (const item of tasks)
					ids.push(await tx.createTask(item.task, item.input, { ownership: { kind: "task", taskId: runtime.taskId } }));
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				if (live.run?.taskId === runtime.taskId && live.run.afterRun) live.run.afterRun.tasks = ids;
				return {
					status: "waiting",
					checkpoint: { phase: "drain", answer: run.answer, tasks: ids },
					on: ids,
					policy: "allSettled",
				};
			}, context);
		},
		drain: async (task, runtime, context) =>
			cutOffTooOften(task, runtime)
				? finishCutOff(runtime, task, task.state.checkpoint.answer, context)
				: finishAnswered(runtime, task.state.checkpoint.answer, context),
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		const pending = deferredRequest(checkpoint);
		if (pending !== undefined) await cancelPolled(runtime, pending, context);
		const calls =
			checkpoint.phase === "tools" ? await unstarted(runtime, checkpoint.assistant, checkpoint.pending, context) : [];
		const liveBeforeAbort = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, runtime.conversationId);
			await convertPartial(tx, live, runtime.conversationId);
			for (const call of calls)
				await appendToolResult(
					tx,
					runtime.conversationId,
					call,
					liveBeforeAbort?.tools?.find((slot) => slot.callId === call.id)?.unoffered
						? harnessError("tool_unavailable", `Tool ${call.name} is not available`)
						: harnessError("aborted", `Tool ${call.name} was aborted`),
					{ timestamp: runtime.now() },
				);
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

async function interruptedRequest(
	runtime: Runtime,
	checkpoint: Extract<GenerationCheckpoint, { phase: "request" | "poll" }>,
	context: Context,
): Promise<void> {
	const { attempt, compacted } = checkpoint;
	const retry = runtime.settings.retry;
	const retrying = retry.enabled && attempt <= retry.maxRetries;
	const until = retrying ? runtime.now() + retryDelayMs(retry, attempt) : 0;
	const message =
		checkpoint.phase === "request"
			? `The host stopped while the model was answering, on attempt ${attempt}`
			: `The host stopped while the deferred answer was fetched, on attempt ${attempt}`;
	if (!retrying && checkpoint.phase === "poll") await cancelPolled(runtime, checkpoint, context);
	await runtime.commit(async (tx): Promise<Next> => {
		const failure = retrying ? undefined : await failureBoundary(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		await convertPartial(tx, live, runtime.conversationId);
		if (failure === undefined) {
			live.generation = { attempt, retry: { at: until, error: message } };
			return {
				status: "sleeping",
				until,
				checkpoint: {
					phase: "retry",
					attempt,
					until,
					...(compacted === undefined ? {} : { compacted }),
					...(checkpoint.phase === "poll"
						? {
								poll: {
									model: checkpoint.model,
									...(checkpoint.thinkingLevel === undefined ? {} : { thinkingLevel: checkpoint.thinkingLevel }),
									cutoff: checkpoint.cutoff,
									handle: checkpoint.handle,
								},
							}
						: {}),
				},
			};
		}
		await endFailed(tx, runtime, live, failure, { status: "unanswered", reason: "interrupted", detail: message });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "interrupted" } } } };
	}, context);
}
function deferredRequest(checkpoint: GenerationCheckpoint) {
	return checkpoint.phase === "retry" ? checkpoint.poll : checkpoint.phase === "poll" ? checkpoint : undefined;
}
async function cancelPolled(
	runtime: Runtime,
	checkpoint: { model: ModelRef; handle: DeferredHandle },
	context: Context,
): Promise<void> {
	const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
	if (model === undefined) return;
	try {
		await runtime.models.cancelDeferred(model, checkpoint.handle, {
			signal: runtime.signal,
			telemetry: context.telemetry,
		});
	} catch (error) {
		runtime.report(error, { kind: "host", callback: "models" });
	}
}
async function endCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	context: Context,
): Promise<void> {
	const checkpoint = task.state.checkpoint;
	const message = `The generation was interrupted ${cutOffCount(task)} in its ${checkpoint.phase} phase`;
	const salvage = salvageable(task, runtime);
	const pending = deferredRequest(checkpoint);
	if (salvage && pending !== undefined) await cancelPolled(runtime, pending, context);
	await runtime.commit(async (tx): Promise<Next> => {
		const failure = await failureBoundary(tx, runtime),
			live = await tx.doc(LiveDoc, runtime.conversationId);
		if (salvage) await convertPartial(tx, live, runtime.conversationId);
		await endFailed(tx, runtime, live, failure, { status: "unanswered", reason: "restart_limit", detail: message });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message, detail: { reason: "restart_limit" } } },
		};
	}, context);
}
async function finishCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	answer: EntryId,
	context: Context,
): Promise<void> {
	const message = `The generation was interrupted ${cutOffCount(task)} in its ${task.state.checkpoint.phase} phase`;
	await runtime.commit(async (tx): Promise<Next> => {
		endRun(tx, await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId, { status: "done", answer });
		return endedByCrashes(
			{ status: "terminal", outcome: { status: "completed", result: { entryId: answer } } },
			message,
		);
	}, context);
}
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
function createTool(
	tx: Tx,
	runtime: Runtime,
	assistant: EntryId,
	callId: string,
	unoffered?: true,
): Promise<TaskId<ToolTaskResult>> {
	return tx.createTask(
		ToolTask,
		{ kind: "model", assistant, callId, ...(unoffered ? { unoffered } : {}) },
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
	settlement: RunEnd,
): Promise<void> {
	endRun(tx, live, runtime.taskId, settlement);
	if (failure.policy === "withdraw") await withdrawQueuedInputs(tx, runtime.conversationId, "run_failed");
	if (failure.boundary !== undefined) {
		const { users, first } = await applyBoundary(tx, failure.boundary, "final", runtime.now());
		if (users.length) await startRun(tx, runtime.conversationId, live, users, first, true);
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
async function failNothingToAnswer(runtime: Runtime, context: Context): Promise<void> {
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await failureBoundary(tx, runtime);
		await endFailed(tx, runtime, await tx.doc(LiveDoc, runtime.conversationId), boundary, {
			status: "unanswered",
			reason: "nothing_to_answer",
		});
		return {
			status: "terminal",
			outcome: {
				status: "failed",
				error: { message: "The conversation has nothing to answer", detail: { reason: "nothing_to_answer" } },
			},
		};
	}, context);
}
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const failure = await failureBoundary(tx, runtime),
			live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailed(tx, runtime, live, failure, {
			status: "unanswered",
			reason: "no_model",
			detail: message,
			settlement: { status: "unanswered", reason: "no_model" },
		});
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
	const changes = new PartialChanges();
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
			const message = copyJson(partial, { omitUndefinedProperties: true }) as PartialMessage;
			const batch = changes.take(message);
			try {
				await runtime.commit(
					async (tx) => {
						const live = await tx.doc(LiveDoc, runtime.conversationId);
						live.generation ??= { attempt };
						changes.commit(live.generation, message, batch);
						return undefined;
					},
					context,
					{ persistence: { kind: "deferred" } },
				);
			} catch (error) {
				changes.restore(batch);
				throw error;
			}
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
			changes.observe(event);
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
	const { attempt, compacted, model, cutoff, thinkingLevel } = request;
	if (thinkingLevel !== undefined) message.thinkingLevel = thinkingLevel;
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
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
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
	const hasAfterRun = await afterRunEnabled(runtime, context);
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId;
		const boundary = await prepareBoundary(tx, id, runtime.settings);
		const live = await tx.doc(LiveDoc, id);
		const entry = await appendAssistant(tx, id, message);
		const continues =
			continuation !== undefined &&
			!boundary.inbox.items.some((item) => item.mode !== "write") &&
			!boundary.inbox.items.some((item) => item.mode === "write" && item.entry.head === "self");
		if (!continues && hasAfterRun) {
			const held = holdAnswer(tx, live, runtime.taskId, { reason: "answer", answer: entry.id, last: entry.id });
			if (held !== undefined) return held;
		}
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continues) {
			await tx.appendEntry(UserEntry, id, {
				model: [{ role: "user", content: continuation!, timestamp: runtime.now() }],
			});
			if (live.run?.taskId === runtime.taskId) live.run.turns = 0;
			handOver(live, runtime.taskId, await newGeneration(tx, id));
			delete live.generation;
		} else {
			endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
			if (users.length) await startRun(tx, id, live, users, first);
		}
		return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
	}, context);
}
async function afterRunEnabled(runtime: Runtime, context: Context): Promise<boolean> {
	return agentHooks(await runtime.agent(context), GenerationTask.definition.name).some(
		({ handlers }) => typeof Reflect.get(handlers, "afterRun") === "function",
	);
}
function holdAnswer(tx: Tx, live: Draft<LiveState>, taskId: TaskId, end: Omit<RunSummary, "first">): Next | undefined {
	if (live.run?.taskId !== taskId) return;
	const run = live.run;
	for (const input of run.inputs) tx.settleSubmission(input, { status: "done", answer: end.answer });
	run.inputs = [];
	run.afterRun = {};
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
	return { status: "running", checkpoint: { phase: "finish", run: { ...end, first: run.first ?? end.answer } } };
}
type PreparedRunTask = { task: Task<JsonValue, { phase: string }, JsonValue, object>; input: JsonValue };
function prepareRunTasks(runtime: Runtime, requests: readonly RunEndTask[], tasks: PreparedRunTask[]): void {
	const errors: unknown[] = [];
	for (const request of requests) {
		try {
			const name = request.task.definition.name;
			if (name.startsWith("axi.")) throw new Error(`An afterRun hook cannot start the built-in task ${name}`);
			const registered = runtime.registry.task(name);
			if (!registered) throw new Error(`Task ${name} is not installed`);
			const definition = registered.definition as PreparedRunTask["task"]["definition"];
			const input = copyJson(request.input, { omitUndefinedProperties: true });
			const checkpoint = copyJson(definition.initial(input), { omitUndefinedProperties: true });
			if (
				typeof checkpoint !== "object" ||
				checkpoint === null ||
				Array.isArray(checkpoint) ||
				typeof checkpoint.phase !== "string" ||
				!Object.hasOwn(definition.phases, checkpoint.phase)
			)
				throw new Error(
					`Task ${name} starts at the unknown phase ${String(checkpoint && typeof checkpoint === "object" ? Reflect.get(checkpoint, "phase") : undefined)}`,
				);
			const phase = checkpoint.phase;
			tasks.push({ task: { definition: { ...definition, initial: () => ({ ...checkpoint, phase }) } }, input });
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length) throw new AggregateError(errors, `${errors.length} afterRun task requests were rejected`);
}
async function finishAnswered(runtime: Runtime, answer: EntryId, context: Context): Promise<void> {
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId,
			boundary = await prepareBoundary(tx, id, runtime.settings),
			live = await tx.doc(LiveDoc, id);
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		endRun(tx, live, runtime.taskId, { status: "done", answer });
		if (users.length) await startRun(tx, id, live, users, first);
		return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } };
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
		if (live.run?.taskId === runtime.taskId) {
			live.run.first ??= entry.id;
			live.run.turns++;
		}
		for (const call of calls) {
			const unoffered = offered.has(call.name) ? {} : { unoffered: true as const };
			if (sequential && started.length) {
				pending.push(call.id);
				slots.push({ callId: call.id, name: call.name, status: "pending", ...unoffered });
			} else {
				const taskId = await createTool(tx, runtime, entry.id, call.id, unoffered.unoffered);
				started.push(taskId);
				slots.push({ callId: call.id, name: call.name, taskId, status: "pending", ...unoffered });
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
	const hasAfterRun = terminate && (await afterRunEnabled(runtime, context));
	const maxTurns = (await runtime.agent(context)).maxTurns;
	await runtime.commit(async (tx): Promise<Next> => {
		const id = runtime.conversationId,
			boundary = await prepareBoundary(tx, id, runtime.settings);
		if (added.length) await addTools(tx, id, added);
		const live = await tx.doc(LiveDoc, id),
			now = runtime.now();
		let last = slots.reduce((id, slot) => Math.max(id, slot.entry ?? id) as EntryId, assistant);
		if (handoff !== undefined) {
			const entry = await tx.appendEntry(ResetEntry, id, {
				head: "self",
				model: [{ role: "user", content: handoff, timestamp: now }],
			});
			boundary.head = entry.id;
			last = entry.id;
		}
		if (hasAfterRun) {
			const held = holdAnswer(tx, live, runtime.taskId, { reason: "terminate", answer: assistant, last });
			if (held !== undefined) return held;
		}
		if (terminate) {
			const { users, first } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length) await startRun(tx, id, live, users, first);
		} else if (maxTurns !== undefined && (live.run?.turns ?? 0) >= maxTurns) {
			const policy = runtime.settings.afterFailedRun;
			const turns = live.run!.turns;
			await endFailed(
				tx,
				runtime,
				live,
				{ policy, ...(policy === "continue" ? { boundary } : {}) },
				{ status: "unanswered", reason: "turn_limit", detail: `${turns} ${turns === 1 ? "turn" : "turns"}` },
			);
		} else {
			const { users, reset, first } = await applyBoundary(tx, boundary, "postTools", now);
			if (reset) {
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				if (users.length) await startRun(tx, id, live, users, first, true);
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
	first?: EntryId,
	keepFailure = false,
): Promise<void> {
	if (!keepFailure) delete live.runFailure;
	live.run = {
		taskId: await newGeneration(tx, id, { submissionIds: inputs }),
		inputs,
		turns: 0,
		...(first === undefined ? {} : { first }),
	};
}
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
export { convertPartial } from "./live.ts";
