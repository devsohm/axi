import { type Context, copyJson, type Draft, type JsonRepresentation, type JsonValue } from "@axi/chord";
import { awaitWithContext } from "@axi/chord/context";
import { overlap } from "@axi/chord/delta";
import { boundOutput, OutputBuffer, type OutputLimits, PROGRESS_BYTES_PER_SECOND, Progress } from "@axi/chord/output";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@axi/ai";
import { validateToolArguments } from "@axi/ai/utils/validation";
import { Compile } from "typebox/compile";
import { defineDocFamily } from "../documents.ts";
import { AssistantEntry, ToolResultEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import { defineTask } from "../tasks.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, utf8ByteLength } from "../truncate.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	Task,
	TaskId,
	TaskOptions,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { toolExtension } from "./agent.ts";
import { assignJson, jsonEqual } from "./json.ts";
import {
	clearProgress,
	finishSlot,
	LiveDoc,
	type NestedToolSlot,
	type NestedToolSummary,
	removeNestedSlots,
	type ToolSlot,
	toolSlot,
} from "./live.ts";
import type {
	NestedToolExecutionResult,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

export type ToolTaskInput =
	| { kind: "model"; assistant: EntryId; callId: string }
	| {
			kind: "nested";
			parent: TaskId;
			parentCallId: string;
			key: string;
			call: ToolCall;
			progress?: false;
	  };
export type ToolTaskCheckpoint =
	| { phase: "call" }
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
export type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" };
export type NestedCallState = {
	taskId?: TaskId<ToolTaskResult>;
	result?: JsonRepresentation<NestedToolExecutionResult>;
};
export const NestedCallDoc = defineDocFamily<NestedCallState, null>({
	checkpointWhen: () => false,
	kind: "axi.tool.nested-call",
	version: 1,
	scope: "task",
	family: true,
	initial: () => ({}),
});
type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Content = (TextContent | ImageContent)[];
type Ending = { readonly status: "completed" | "aborted" } | { readonly status: "failed"; readonly message: string };
type Reported = {
	output: OutputBuffer;
	limits: OutputLimits;
	diagnostics: ToolDiagnostic[];
	details: JsonValue | undefined;
};
const nestedMemo = "axi.tool.madeNestedCalls";
const completed: Ending = { status: "completed" };

export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "axi.tool",
	version: 2,
	initial: () => ({ phase: "call" }),
	migrate: (input, checkpoint) => ({
		input: { kind: "model", ...(input as { assistant: EntryId; callId: string }) },
		checkpoint: checkpoint as ToolTaskCheckpoint,
	}),
	phases: {
		call: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context),
				tool = await findTool(runtime, task.input, call.name, context);
			if (tool === undefined)
				return settle(
					runtime,
					task.input,
					call,
					completed,
					() => harnessError("tool_unavailable", `Tool ${call.name} is not available`),
					context,
				);
			let checked: { args: JsonObject } | { error: string };
			try {
				const args = tool.prepareArguments === undefined ? call.arguments : tool.prepareArguments(call.arguments);
				checked = checkArguments(tool, call, args as JsonObject);
			} catch (error) {
				checked = { error: errorMessage(error) };
			}
			if ("error" in checked)
				return settle(
					runtime,
					task.input,
					call,
					completed,
					() => harnessError("invalid_arguments", checked.error),
					context,
				);
			let args = checked.args,
				block: string | undefined;
			await runtime.hooks.each("beforeTool", async (hook) => {
				if (block !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					block = errorMessage(error);
				}
			});
			if (block !== undefined)
				return settle(
					runtime,
					task.input,
					call,
					completed,
					() => harnessError("blocked", `Tool call blocked: ${block}`),
					context,
				);
			const final = checkArguments(tool, call, args);
			if ("error" in final)
				return settle(
					runtime,
					task.input,
					call,
					completed,
					() => harnessError("invalid_arguments", final.error),
					context,
				);
			const prepared = copyJson(final.args, { omitUndefinedProperties: true }) as JsonObject;
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot !== undefined) {
					slot.status = "running";
					if (task.input.kind === "nested" && "parentTaskId" in slot && !jsonEqual(task.input.call.arguments, prepared))
						slot.arguments = prepared;
				}
				return {
					status: "running",
					checkpoint: { phase: "execute", arguments: prepared, replay: tool.replay ?? "unsafe" },
				};
			}, context);
			await execute(runtime, task.input, call, tool, prepared, context);
		},
		execute: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context),
				tool = await findTool(runtime, task.input, call.name, context);
			if (task.state.checkpoint.replay === "safe" && tool?.replay === "safe") {
				await runtime.commit(async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot) clearProgress(slot);
					return undefined;
				}, context);
				return execute(runtime, task.input, call, tool, task.state.checkpoint.arguments, context);
			}
			const message = `Tool ${call.name} was interrupted and may have partially run`;
			await settle(
				runtime,
				task.input,
				call,
				{ status: "failed", message },
				(slot) => interrupted(slot, "interrupted", message),
				context,
			);
		},
	},
	abort: async (task, runtime, context) => {
		const call = await readCall(runtime, task.input, context);
		let code: string, text: string;
		if (task.abortReason !== "restart") {
			code = "aborted";
			text = `Tool ${call.name} was aborted`;
		} else if (task.state.checkpoint.phase === "execute") {
			code = "interrupted";
			text = `Tool ${call.name} was interrupted by a restart and may have partially run`;
		} else {
			code = "abandoned";
			text = `Tool ${call.name} was not started: its caller ended with a restart`;
		}
		await settle(runtime, task.input, call, { status: "aborted" }, (slot) => interrupted(slot, code, text), context);
	},
});

async function findTool(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	const agent = await runtime.agent(context);
	return (input.kind === "model" ? agent.tools : agent.callable).find((tool) => tool.name === name);
}
async function readCall(runtime: Runtime, input: ToolTaskInput, context: Context): Promise<ToolHookCall> {
	if (input.kind === "nested") {
		context.telemetry.setAttributes({ "tool.name": input.call.name, "tool.call_id": input.call.id });
		return { ...input.call, parent: { taskId: input.parent, callId: input.parentCallId } };
	}
	const message = (await runtime.entry(AssistantEntry, input.assistant, context))?.model?.[0];
	const call =
		message?.role === "assistant"
			? message.content.find((part): part is ToolCall => part.type === "toolCall" && part.id === input.callId)
			: undefined;
	if (call === undefined) throw new Error(`Entry ${input.assistant} has no tool call ${input.callId}`);
	context.telemetry.setAttributes({ "tool.name": call.name, "tool.call_id": call.id });
	return call;
}
function checkArguments(
	tool: ToolRegistration,
	call: ToolCall,
	args: JsonObject,
): { args: JsonObject } | { error: string } {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

async function execute(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	context: Context,
): Promise<void> {
	const limits: OutputLimits = {
		maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool.outputLimits?.retain ?? "head",
	};
	const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined };
	const progress = publish(runtime, reported, input.kind === "model" || input.progress !== false, context);
	const admissions: Promise<unknown>[] = [];
	const resumes = tool.replay === "safe";
	let sequence = 0,
		memoWrite: Promise<unknown> | undefined,
		ended = false,
		env: ExecutionEnv | undefined;
	const assertLive = () => {
		if (ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	const api: ToolExecutionApi = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		registry: runtime.registry,
		agent: runtime.agent,
		get models() {
			return runtime.models;
		},
		get env() {
			return env;
		},
		now: () => runtime.now(),
		output: (chunk, skipped) => {
			assertLive();
			if (reported.output.push(chunk, skipped)) progress.mark();
		},
		outputWindow:
			limits.retain === "tail"
				? {
						maxBytes: limits.maxBytes,
						maxLines: limits.maxLines,
						minIntervalMs: runtime.settings.progress.outputIntervalMs,
						bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
					}
				: undefined,
		retainedOutput: () => {
			assertLive();
			const value = reported.output.snapshot();
			return { text: value.text, truncated: value.droppedBytes > 0 };
		},
		diagnostic: (value) => {
			assertLive();
			reported.diagnostics.push(copyJson(value, { omitUndefinedProperties: true }) as ToolDiagnostic);
			progress.mark();
		},
		details: async (value, ctx) => {
			assertLive();
			ctx.abortSignal?.throwIfAborted();
			reported.details = copyJson(value, { omitUndefinedProperties: true });
			const waiting = progress.markAndWait();
			waiting.catch(() => {});
			return awaitWithContext(waiting, ctx);
		},
		commit: async (change, ctx) => {
			let value: Awaited<ReturnType<typeof change>> | undefined;
			await runtime.commit(async (tx) => {
				value = await change(tx);
				return undefined;
			}, ctx);
			return value as Awaited<ReturnType<typeof change>>;
		},
		memo: runtime.memo,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			value: I,
			options: Omit<TaskOptions, "conversationId">,
			ctx: Context,
		): Promise<TaskId<R>> => {
			const child = options.ownership.kind === "task" && !resumes ? { abandonOnRestart: true, ...options } : options;
			let id: TaskId<R> | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, value, child);
				return undefined;
			}, ctx);
			return id!;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
		executeTool: async (name, arguments_, ctx, options = {}) => {
			assertLive();
			const key = options.key ?? String(++sequence);
			if (options.key !== undefined) validateKey(key);
			memoWrite ??= runtime.memo(nestedMemo, true, ctx).catch((error: unknown) => {
				memoWrite = undefined;
				throw error;
			});
			const pending = memoWrite.then(() =>
				admitNested(
					runtime,
					call.id,
					name,
					arguments_,
					{ key, progress: options.progress, abandonOnRestart: !resumes },
					ctx,
				),
			);
			admissions.push(pending);
			const id = await pending,
				receipt = await runtime.waitForTask(id, ctx),
				result = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, ctx))?.result;
			return result === undefined
				? fallback(id, name, receipt.state.outcome)
				: (copyJson(result) as unknown as NestedToolExecutionResult);
		},
	};
	let result: ToolExecutionResult,
		ending = completed,
		durationMs: number | undefined;
	try {
		env = await runtime.env(context);
		const start = performance.now();
		try {
			result = await tool.execute(args, api, context);
		} finally {
			durationMs = Math.round(performance.now() - start);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
			throw error;
		}
		result = { isError: true, diagnostics: [diagnostic("tool_error", errorMessage(error))] };
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	ended = true;
	await Promise.allSettled(admissions);
	reported.output.end();
	const waiters = await progress.stop();
	try {
		const value = await prepareResult(runtime, input, call, tool, result, reported, context);
		await settle(runtime, input, call, ending, () => value, context, durationMs);
	} catch (error) {
		for (const waiter of waiters) waiter.reject(error);
		throw error;
	}
	for (const waiter of waiters) waiter.resolve();
}

function publish(runtime: Runtime, reported: Reported, enabled: boolean, context: Context): Progress {
	let written: { text: string; details: JsonValue | undefined; diagnostics: number } = {
			text: "",
			details: undefined,
			diagnostics: 0,
		},
		lastTime = 0;
	return new Progress(
		async () => {
			if (!enabled) return 0;
			const output = reported.output.snapshot(),
				current = { text: output.text, details: reported.details, diagnostics: reported.diagnostics.length };
			const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics),
				changed = current.details !== written.details;
			let bytes =
				output.text === written.text
					? 0
					: utf8ByteLength(
							output.text.slice(
								output.text.startsWith(written.text) ? written.text.length : overlap(written.text, output.text, 65536),
							),
						);
			if (changed) bytes += utf8ByteLength(JSON.stringify(current.details ?? null));
			if (added.length) bytes += utf8ByteLength(JSON.stringify(added));
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot === undefined) return undefined;
				if ((slot.output ?? "") !== output.text) slot.output = output.text;
				if (output.droppedBytes > 0) slot.droppedBytes = output.droppedBytes;
				if (output.droppedLines > 0) slot.droppedLines = output.droppedLines;
				if (changed && current.details !== undefined)
					assignJson(slot as unknown as JsonObject, "details", current.details);
				if (added.length) {
					slot.diagnostics ??= [];
					for (const diagnostic of added) slot.diagnostics.push(diagnostic);
				}
				return undefined;
			}, context);
			written = current;
			return bytes;
		},
		(error) => {
			if (!runtime.signal.aborted) runtime.report(error);
		},
		runtime.settings.progress.outputIntervalMs,
		{
			now: () => {
				try {
					lastTime = runtime.now();
				} catch {}
				return lastTime;
			},
			setTimer: (callback, delay) => runtime.setTimer(callback, delay),
		},
	);
}

const validators = new WeakMap<object, ReturnType<typeof Compile>>();
function outputError(tool: ToolRegistration, result: ToolExecutionResult): string | undefined {
	const schema = tool.structuredOutputSchema,
		output = result.structuredOutput;
	if (schema === undefined)
		return output === undefined
			? undefined
			: `Tool ${tool.name} returned structuredOutput but declares no structuredOutputSchema`;
	if (output === undefined)
		return result.isError === true ? undefined : `Tool ${tool.name} returned no structuredOutput`;
	let validator = validators.get(schema);
	if (validator === undefined) {
		validator = Compile(schema);
		validators.set(schema, validator);
	}
	if (validator.Check(output)) return;
	const first = validator.Errors(output)[0],
		path = first?.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
	return `Tool ${tool.name} returned structuredOutput that does not match its schema: ${path}: ${first?.message ?? "invalid"}`;
}
async function prepareResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	result: ToolExecutionResult,
	reported: Reported,
	context: Context,
): Promise<ToolExecutionResult> {
	const extras: ToolDiagnostic[] = [],
		retained = result.output === undefined ? reported.output.snapshot() : undefined;
	const output: Content =
		retained === undefined ? result.output! : retained.text === "" ? [] : [{ type: "text", text: retained.text }];
	let final: ToolExecutionResult = {
		...result,
		output,
		details: result.details === undefined ? reported.details : result.details,
		diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
	};
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	if (retained !== undefined && retained.droppedBytes > 0 && final.output === output)
		extras.push(truncation(retained, reported.limits.retain));
	const bounded = boundContent(final.output ?? [], reported.limits);
	if (bounded.droppedBytes > 0) extras.push(truncation(bounded, reported.limits.retain));
	const broken = outputError(tool, final);
	if (broken !== undefined) {
		const { structuredOutput: _, ...rest } = final;
		if (input.kind === "nested") {
			final = { ...rest, isError: true };
			extras.push(diagnostic("invalid_structured_output", broken));
		} else {
			final = rest;
			const extension = await runtime.agent(context).then(
				(agent) => toolExtension(agent, tool.name),
				() => undefined,
			);
			runtime.report(new Error(broken), { type: "extension", ...optionalExtension(extension) });
		}
	}
	if (input.kind === "nested") {
		if (tool.structuredOutputSchema === undefined)
			final = { ...final, structuredOutput: outputValue(bounded.content) as JsonValue };
		else if (
			final.isError === true &&
			final.structuredOutput === undefined &&
			![...(final.diagnostics ?? []), ...extras].some((item) => item.severity === "error")
		) {
			const text = bounded.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
			if (text !== "") extras.push(diagnostic("tool_error", text));
		}
	}
	return { ...final, output: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...extras] };
}

async function settle(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	ending: Ending,
	build: (slot: Readonly<ToolSlot | NestedToolSlot> | undefined) => ToolExecutionResult,
	context: Context,
	durationMs?: number,
): Promise<void> {
	const nested = (await runtime.ownedTasks(context)).filter(
		(task) => task.kind === ToolTask.definition.name && (task.input as ToolTaskInput).kind === "nested",
	);
	const hadNested = (await runtime.memo(nestedMemo, context)) === true;
	await Promise.all(nested.map((task) => runtime.abortOwned(task.id, context)));
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId),
			slot = toolSlot(live, runtime.taskId),
			result = build(slot);
		let receipt: ToolTaskResult;
		if (input.kind === "nested") {
			const value = copyJson(
				{
					taskId: runtime.taskId,
					structuredOutput: result.structuredOutput,
					isError: result.isError ?? false,
					details: result.details,
					diagnostics: result.diagnostics ?? [],
					usage: result.usage,
					durationMs,
				} as unknown as JsonValue,
				{ omitUndefinedProperties: true },
			) as unknown as NestedToolExecutionResult;
			if (value.usage !== undefined) await recordUsage(tx, runtime.conversationId, "tools", call.name, value.usage);
			const state = await tx.doc(NestedCallDoc, input.parent, input.key, null);
			if (state.taskId !== runtime.taskId) throw new Error(`Nested call ${call.id} is not in its caller's index`);
			state.result = value as unknown as Draft<JsonRepresentation<NestedToolExecutionResult>>;
			if (slot !== undefined && "parentTaskId" in slot) {
				finishSlot(slot);
				slot.summary = summary(value, result.output ?? []);
			}
			receipt = { kind: "nested" };
		} else {
			const entry = await appendToolResult(tx, runtime.conversationId, call, result, {
				timestamp: runtime.now(),
				durationMs,
			});
			if (slot !== undefined && !("parentTaskId" in slot)) {
				finishSlot(slot);
				slot.entry = entry.id;
			}
			receipt = {
				kind: "model",
				entryId: entry.id,
				...(result.control !== undefined && ending.status === "completed"
					? { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl }
					: {}),
			};
		}
		if (hadNested) removeNestedSlots(live, runtime.taskId);
		if (ending.status === "failed")
			return { status: "terminal", outcome: { status: "failed", error: { message: ending.message }, result: receipt } };
		return { status: "terminal", outcome: { status: ending.status, result: receipt } };
	}, context);
}

async function admitNested(
	runtime: Runtime,
	parentCallId: string,
	name: string,
	args: JsonObject,
	options: { key: string; progress: boolean | undefined; abandonOnRestart: boolean },
	context: Context,
): Promise<TaskId<ToolTaskResult>> {
	const call: ToolCall = {
		type: "toolCall",
		id: `${parentCallId}/${options.key}`,
		name,
		arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject,
	};
	let id: TaskId<ToolTaskResult> | undefined;
	let replayed = false;
	await runtime.commit(async (tx) => {
		const state = await tx.doc(NestedCallDoc, runtime.taskId, options.key, null);
		if (state.taskId !== undefined) {
			const existing = (await tx.task(state.taskId))?.input as ToolTaskInput | undefined;
			if (
				existing?.kind !== "nested" ||
				existing.call.name !== name ||
				!jsonEqual(existing.call.arguments, call.arguments)
			)
				throw new Error(`Nested call ${call.id} was already made with another tool or other arguments`);
			id = state.taskId;
			replayed = state.result !== undefined;
			return undefined;
		}
		const input: ToolTaskInput = {
			kind: "nested",
			parent: runtime.taskId,
			parentCallId,
			key: options.key,
			call,
			...(options.progress === false ? { progress: false } : {}),
		};
		id = await tx.createTask(ToolTask, input, {
			ownership: { kind: "task", taskId: runtime.taskId },
			abandonOnRestart: options.abandonOnRestart,
		});
		state.taskId = id;
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		live.nestedTools ??= [];
		live.nestedTools.push({
			callId: call.id,
			parentCallId,
			parentTaskId: runtime.taskId,
			name,
			taskId: id,
			arguments: call.arguments as JsonObject,
			status: "pending",
		});
		return undefined;
	}, context);
	if (replayed) context.telemetry.addEvent("axi.durable.replay", { "tool.name": name });
	return id!;
}
function validateKey(key: string): void {
	if (key === "" || key.includes("/") || key === "__proto__" || /^[1-9][0-9]*$/.test(key))
		throw new Error(
			`Nested call key ${JSON.stringify(key)} must be non-empty, without "/", not "__proto__", and not a positive integer`,
		);
}
function outputValue(content: Content): string | ImageContent | Content {
	if (!content.length) return "";
	if (content.length !== 1) return content;
	return content[0]!.type === "text" ? content[0]!.text : content[0]!;
}
function fallback(taskId: TaskId, name: string, outcome: TaskOutcome<ToolTaskResult>): NestedToolExecutionResult {
	const message =
		outcome.status === "faulted"
			? `Tool ${name} failed: ${outcome.error.message}`
			: outcome.status === "orphaned"
				? `Tool ${name} could not resume: ${outcome.reason}`
				: `Tool ${name} ended without a result`;
	return { taskId, isError: true, diagnostics: [diagnostic(outcome.status, message)] };
}
function diagnostic(code: string, message: string): ToolDiagnostic {
	return { severity: "error", code, message };
}
export function harnessError(code: string, message: string): ToolExecutionResult {
	return { output: [], isError: true, diagnostics: [diagnostic(code, message)] };
}
function truncation(counts: { droppedBytes: number; droppedLines: number }, retain?: "head" | "tail"): ToolDiagnostic {
	const where = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${where}: ${counts.droppedLines} lines, ${counts.droppedBytes} bytes dropped`,
	};
}
function interrupted(
	slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
	code: string,
	message: string,
): ToolExecutionResult {
	const diagnostics = [...(slot?.diagnostics ?? [])];
	if ((slot?.droppedBytes ?? 0) > 0)
		diagnostics.push(truncation({ droppedBytes: slot!.droppedBytes!, droppedLines: slot!.droppedLines ?? 0 }));
	return {
		output: slot?.output ? [{ type: "text", text: slot.output }] : [],
		isError: true,
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics: [...diagnostics, diagnostic(code, message)],
	};
}
function summary(result: NestedToolExecutionResult, output: Content): NestedToolSummary {
	const errors = result.diagnostics.filter((item) => item.severity === "error");
	const text = result.isError
		? (errors.length
				? errors.map((item) => item.message).join("\n")
				: output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
			).slice(0, 500)
		: "";
	return {
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(text === "" ? {} : { error: text }),
	};
}
export async function appendToolResult(
	tx: Tx,
	conversationId: ConversationId,
	call: ToolCall,
	result: ToolExecutionResult,
	meta: { readonly timestamp: number; readonly durationMs?: number },
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>> {
	const diagnostics = [...(result.diagnostics ?? [])],
		content: Content = [...(result.output ?? [])];
	if (diagnostics.length)
		content.push({
			type: "text",
			text: `<harness>\n${diagnostics.map((item) => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`,
		});
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		isError: result.isError ?? false,
		timestamp: meta.timestamp,
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
	};
	if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);
	return tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics } });
}
function boundContent(
	content: Content,
	limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
	const texts = content.filter((item): item is TextContent => item.type === "text"),
		bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 };
	const anchor = limits.retain === "head" ? texts[0] : texts.at(-1),
		result: Content = [];
	for (const item of content)
		if (item.type !== "text") result.push(item);
		else if (item === anchor) result.push({ ...item, text: bounded.text });
	return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines };
}
