import { type Context, copyJson, type JsonValue } from "@axi/chord";
import {
	type CodemodeHostCall,
	type CodemodeOutcome,
	type CodemodeResult,
	type CodemodeRun,
	type CodemodeSandboxBase,
	toCodemodeIdentifier,
} from "@axi/codemode/portable";
import { CODEMODE_SOURCE_GRAMMAR, parseCodemodeSource } from "@axi/codemode/source";
import { type Static, Type } from "typebox";
import { defineDoc } from "../documents.ts";
import { errorMessage } from "../errors.ts";
import { defineExtension, defineTool, section } from "../harness/define.ts";
import { jsonEqual } from "../harness/json.ts";
import { NestedCallDoc, type ToolTaskInput } from "../harness/tool.ts";
import type { Extension, NestedToolExecutionResult, ToolExecutionApi, ToolExecutionResult } from "../harness/types.ts";
import { rankDocuments } from "../search.ts";
import type { JsonObject } from "../types.ts";
import {
	type CodemodeNamespace,
	codemodeDescription,
	codemodeSection,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	namespaceOf,
	sampleOf,
} from "./describe.ts";
import {
	CATALOG_GLOBALS,
	CODEMODE_INTERNAL_PREFIX,
	catalogCall,
	createModelTools,
	GENERATE_IMAGES_TOOL,
	MAX_CONCURRENT_MODEL_CALLS,
	MODEL_CALLS,
} from "./models.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, formatResult, type OutputFile } from "./output.ts";

export const CODEMODE_MODULE_VERSION = 2;
export const CODEMODE_TOOL_NAME = "codemode";
type Tool = { name: string; jsName: string; description: string; structured?: true; hidden?: true };
type Start = {
	version: number;
	startedAt: number;
	seed: number;
	fingerprint?: string;
	deadline?: number;
	tools: Tool[];
	namespaces: { name: string; description?: string; instructions?: string; tools: string[] }[];
	globals: { name: string; spread: boolean }[];
	maxOutputTokens: number;
	store: Record<string, JsonValue>;
};
type RunState = { start?: Start; outputDir?: string; result?: JsonObject };
type Delivery = {
	id: number;
	at: number;
	issuedAfter?: number;
	global?: { name: string; args?: JsonValue; outcome: JsonObject };
};
type Journal = { entries: Delivery[]; firstIssued?: number };
export const CodemodeRunDoc = defineDoc<RunState>({
	checkpointWhen: () => false,
	kind: "axi.codemode.run",
	version: 1,
	scope: "task",
	initial: () => ({}),
});
export const CodemodeJournalDoc = defineDoc<Journal>({
	checkpointWhen: () => false,
	kind: "axi.codemode.journal",
	version: 1,
	scope: "task",
	initial: () => ({ entries: [] }),
});
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	kind: "axi.codemode.store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
});
export type CodemodeNestedCall = {
	id: number;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
};
export type CodemodeToolDetails = { calls: CodemodeNestedCall[]; fullOutputPath?: string };
export type CodemodeGlobal = {
	readonly name: string;
	readonly spread?: boolean;
	execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<JsonValue | undefined>;
};
const parameters = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });
export type CodemodeToolInput = Static<typeof parameters>;
export type CodemodeToolOptions = {
	readonly sandbox: CodemodeSandboxBase;
	readonly namespaces?: readonly CodemodeNamespace[];
	readonly inlineBudget?: number;
	readonly models?: boolean;
	readonly globals?: readonly CodemodeGlobal[];
};
const limits = { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 };
const discoveryNames = ["searchTools", "describeTool", "describeNamespace"];
const cut = (text: string, count: number): string => (text.length <= count ? text : `${text.slice(0, count - 3)}...`);
const clone = <T>(value: T): T => copyJson(value, { omitUndefinedProperties: true }) as T;
const failed = (message: string): ToolExecutionResult => ({ output: [{ type: "text", text: message }], isError: true });
const describeCall = (call: CodemodeHostCall): string =>
	`${call.target === "tool" ? "tools." : ""}${call.name}(${JSON.stringify(call.args) ?? ""})`;

export function createCodemodeTool(options: CodemodeToolOptions) {
	return defineTool({
		name: CODEMODE_TOOL_NAME,
		description: codemodeDescription(options.models !== false),
		parameters,
		outputLimits: limits,
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		callers: ["model"],
		replay: "safe",
		execute: (args, api, context) => new ScriptCall(options, api, context).execute(args.code),
	});
}
export function createCodemodeExtension(options: CodemodeToolOptions): Extension {
	return defineExtension({
		name: "codemode",
		tools: [createCodemodeTool(options), ...(options.models === false ? [] : createModelTools())],
		sections: [
			section("codemode", (input) =>
				codemodeSection(
					input.agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) && !tool.deferred),
					options.namespaces ?? [],
					options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
				),
			),
		],
	});
}

function toolOutcome(name: string, structured: boolean, result: NestedToolExecutionResult): CodemodeOutcome {
	const raw = result.structuredOutput;
	const value = structured
		? raw
		: typeof raw === "string"
			? raw
			: Array.isArray(raw)
				? raw
						.flatMap((item) =>
							typeof item === "object" && item !== null && !Array.isArray(item) && item.type === "text"
								? [item.text]
								: [],
						)
						.join("\n")
				: "";
	if (!result.isError || (structured && value !== undefined)) return { ok: true, value };
	const errors = result.diagnostics
		.filter((note) => note.severity === "error")
		.map((note) => note.message)
		.join("\n");
	return {
		ok: false,
		message: (!structured && typeof value === "string" ? value : "") || errors || `Tool ${name} failed`,
		...(value === undefined ? {} : { properties: { structuredOutput: value } }),
	};
}
function modelCall(call: CodemodeHostCall): CodemodeHostCall {
	const tool = call.target === "global" ? MODEL_CALLS[call.name] : undefined;
	if (tool === undefined) return call;
	const [model, context] = Array.isArray(call.args) ? call.args : [];
	return { id: call.id, target: "tool", name: tool, args: { model: model ?? null, context: context ?? null } };
}

class ScriptCall {
	private readonly options: CodemodeToolOptions;
	private readonly api: ToolExecutionApi;
	private readonly context: Context;
	private readonly controller = new AbortController();
	private readonly gate = Promise.withResolvers<void>();
	private run: CodemodeRun | undefined;
	private start!: Start;
	private replay: Delivery[] = [];
	private replayIndex = new Map<number, number>();
	private cursor = 0;
	private replaying = false;
	private rerun = false;
	private firstIssued: number | undefined;
	private issued = 0;
	private covered = 0;
	private length = 0;
	private released = false;
	private held: CodemodeHostCall[] = [];
	private waiting: CodemodeHostCall[] = [];
	private readonly ready = new Map<number, CodemodeOutcome>();
	private queue: { id: number; at: number; outcome: CodemodeOutcome; global?: Delivery["global"] }[] = [];
	private readonly acknowledgments = new Map<number, number>();
	private saving = false;
	private ended: ToolExecutionResult | undefined;
	private failure: unknown;
	private readonly rows = new Map<number, CodemodeNestedCall>();
	private modelCalls = 0;
	private readonly modelWaiters: (() => void)[] = [];
	private images = 0;
	constructor(options: CodemodeToolOptions, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.api = api;
		this.context = context;
	}
	private get stopped(): boolean {
		return this.ended !== undefined || this.failure !== undefined || this.run?.finished === true;
	}

	async execute(source: string): Promise<ToolExecutionResult> {
		const { api, context, options } = this;
		const parsed = parseCodemodeSource(source);
		const agent = await api.agent(context);
		const tools: Tool[] = agent.callable.map((tool) => ({
			name: tool.name,
			jsName: toCodemodeIdentifier(tool.name),
			description: sampleOf(tool),
			...(tool.structuredOutputSchema === undefined ? {} : { structured: true }),
			...(tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) ? { hidden: true } : {}),
		}));
		const namespaces: Start["namespaces"] = [];
		for (const tool of agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX))) {
			const namespace = namespaceOf(tool.name, options.namespaces ?? []);
			if (!namespace) continue;
			let found = namespaces.find((item) => item.name === namespace.name);
			if (!found) {
				found = {
					name: namespace.name,
					...(namespace.description === undefined ? {} : { description: namespace.description }),
					...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
					tools: [],
				};
				namespaces.push(found);
			}
			found.tools.push(tool.name);
		}
		const globals = [
			...discoveryNames.map((name) => ({ name, spread: true })),
			...(options.models === false
				? []
				: [...CATALOG_GLOBALS, ...Object.keys(MODEL_CALLS)].map((name) => ({ name, spread: true }))),
			...(options.globals ?? []).map((global) => ({ name: global.name, spread: global.spread === true })),
		];
		const now = api.now();
		const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
		type Found =
			| { done: ToolExecutionResult }
			| { start: Start; entries: Delivery[]; firstIssued: number | undefined; rerun: boolean };
		const found = await api.commit(async (tx): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			if (run.result !== undefined) return { done: clone(run.result) as ToolExecutionResult };
			const rerun = run.start !== undefined;
			if (run.start === undefined) {
				const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
				run.start = {
					version: CODEMODE_MODULE_VERSION,
					startedAt: now,
					seed,
					...(parsed.options.timeoutMs === undefined ? {} : { deadline: now + parsed.options.timeoutMs }),
					tools,
					namespaces,
					globals,
					maxOutputTokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					store: clone(store.values),
				};
			}
			const journal = await tx.doc(CodemodeJournalDoc, api.taskId);
			return { start: clone(run.start), entries: clone(journal.entries), firstIssued: journal.firstIssued, rerun };
		}, context);
		if ("done" in found) return found.done;
		this.start = found.start;
		this.replay = found.entries;
		this.length = found.entries.length;
		this.replayIndex = new Map(found.entries.map((entry, index) => [entry.id, index]));
		this.replaying = this.length > 0;
		this.rerun = found.rerun;
		this.firstIssued = found.firstIssued;
		this.covered = found.entries.reduce((max, entry) => Math.max(max, entry.issuedAfter ?? 0), found.firstIssued ?? 0);
		if (this.start.version !== CODEMODE_MODULE_VERSION)
			return this.decide(
				failed(
					`The script cannot resume: it started under code mode version ${this.start.version}, this is ${CODEMODE_MODULE_VERSION}.`,
				),
			);
		const remaining = this.start.deadline === undefined ? undefined : this.start.deadline - api.now();
		if (remaining !== undefined && remaining <= 0)
			return this.decide(failed("Script timed out: its deadline passed while it was interrupted."));
		const abort = () => this.controller.abort(context.abortSignal?.reason);
		context.abortSignal?.addEventListener("abort", abort, { once: true });
		if (context.abortSignal?.aborted) abort();
		try {
			this.run = options.sandbox.start(parsed.code, {
				startedAt: this.start.startedAt,
				seed: this.start.seed,
				tools: this.start.tools.filter((tool) => !tool.hidden),
				globals: this.start.globals,
				store: this.start.store,
				signal: this.controller.signal,
				...(remaining === undefined ? {} : { timeoutMs: remaining }),
				onStarted: (fingerprint) => {
					void this.fingerprint(fingerprint);
				},
				onCall: (call) => this.called(call),
				onIdle: (seq, issued) => this.idle(seq, issued),
			});
			const result = await this.run.result;
			if (this.failure !== undefined) throw this.failure;
			if (this.ended !== undefined) return this.ended;
			context.abortSignal?.throwIfAborted();
			if (!result.ok && result.error.kind === "aborted" && !this.controller.signal.aborted) {
				await new Promise<void>((resolve) => {
					if (!context.abortSignal || context.abortSignal.aborted) resolve();
					else context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
				});
				context.abortSignal?.throwIfAborted();
				throw new Error("The code mode sandbox was closed while the script ran");
			}
			const during = result.during;
			if (this.rerun && during !== undefined && during.seq <= this.replay.length) {
				const continued =
					(during.seq === 0
						? this.replay.length > 0 || this.firstIssued !== undefined
						: this.replay[during.seq - 1]?.issuedAfter !== undefined) ||
					this.replay.slice(during.seq).some((entry) => entry.id > during.issued);
				if (continued)
					return this.decide(
						failed(
							`The script took a different path when resumed after a restart: it ended after result ${during.seq}, where it went on before.`,
						),
					);
			}
			return this.complete(result);
		} finally {
			context.abortSignal?.removeEventListener("abort", abort);
		}
	}

	private details(): CodemodeToolDetails {
		return {
			calls: [...this.rows.values()]
				.sort((a, b) => a.id - b.id)
				.map((row) => (row.status === "running" ? { ...row, status: "cancelled" } : row)),
		};
	}
	private async decide(decision: ToolExecutionResult): Promise<ToolExecutionResult> {
		const result = { ...decision, details: this.details() };
		await this.api.commit(async (tx) => {
			(await tx.doc(CodemodeRunDoc, this.api.taskId)).result ??= copyJson(result, {
				omitUndefinedProperties: true,
			}) as JsonObject;
		}, this.context);
		return result;
	}
	private fail(error: unknown): void {
		if (this.failure === undefined) {
			this.failure = error;
			this.controller.abort(error);
		}
	}
	private diverge(message: string): void {
		if (this.ended !== undefined || this.failure !== undefined) return;
		this.ended = failed(`The script took a different path when resumed after a restart: ${message}`);
		void this.decide(this.ended).then(
			() => this.controller.abort(new Error(message)),
			(error) => this.fail(error),
		);
	}
	private async complete(result: CodemodeResult): Promise<ToolExecutionResult> {
		const details = this.details();
		const formatted = await formatResult(result, {
			generatedImages: this.images,
			wallMs: this.api.now() - this.start.startedAt,
			maxOutputTokens: this.start.maxOutputTokens,
			calls: details.calls,
			limits,
			write: this.outputFiles(),
		});
		const output: ToolExecutionResult = {
			output: formatted.content,
			isError: !result.ok,
			details: {
				...details,
				...(formatted.fullOutputPath === undefined ? {} : { fullOutputPath: formatted.fullOutputPath }),
			},
		};
		return this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			if (run.result !== undefined) return run.result as ToolExecutionResult;
			run.result = copyJson(output, { omitUndefinedProperties: true }) as JsonObject;
			if (result.ok && (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length)) {
				const store = await tx.doc(CodemodeStoreDoc, this.api.conversationId);
				for (const key of result.storeWrites.delete) delete store.values[key];
				for (const [key, value] of Object.entries(result.storeWrites.set)) store.values[key] = value as JsonValue;
			}
			return output;
		}, this.context);
	}
	private outputFiles(): OutputFile {
		const env = this.api.env;
		let directory: Promise<string> | undefined;
		return async (name, data) => {
			if (env === undefined) return { error: "no execution environment" };
			try {
				directory ??= (async () => {
					const saved = await this.api.commit(
						async (tx) => (await tx.doc(CodemodeRunDoc, this.api.taskId)).outputDir,
						this.context,
					);
					if (saved !== undefined) return saved;
					const created = await env.createTempDir("axi-codemode-", this.context);
					if (!created.ok) throw new Error(created.error.message);
					return this.api.commit(async (tx) => {
						const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
						run.outputDir ??= created.value;
						return run.outputDir;
					}, this.context);
				})();
				const path = `${await directory}/${name}`;
				const result = await env.writeFile(path, data, this.context);
				return result.ok ? { path } : { error: result.error.message };
			} catch (error) {
				return { error: errorMessage(error) };
			}
		};
	}
	private async fingerprint(value: string): Promise<void> {
		const previous = this.start.fingerprint;
		if (previous !== undefined && previous !== value) {
			this.ended = failed(`The script cannot resume: the sandbox changed since it started (${previous} -> ${value}).`);
			await this.decide(this.ended).catch((error) => this.fail(error));
			this.controller.abort(new Error("Sandbox fingerprint changed"));
			return;
		}
		if (previous === undefined) {
			try {
				await this.api.commit(async (tx) => {
					const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
					if (run.start !== undefined) run.start.fingerprint = value;
				}, this.context);
			} catch (error) {
				this.fail(error);
				return;
			}
		}
		this.gate.resolve();
		if (this.replaying) this.deliverReplay();
		else if (!this.rerun) void this.release();
	}
	private called(made: CodemodeHostCall): void {
		if (this.stopped) return;
		const call = modelCall(made);
		if (call.target === "tool" && !this.rows.has(call.id))
			this.rows.set(call.id, {
				id: call.id,
				name: call.name.startsWith(CODEMODE_INTERNAL_PREFIX)
					? call.name.slice(CODEMODE_INTERNAL_PREFIX.length)
					: call.name,
				args: cut(call.args === undefined ? "" : (JSON.stringify(call.args) ?? ""), 200),
				status: "running",
			});
		this.issued = Math.max(this.issued, call.id);
		const index = this.replaying ? this.replayIndex.get(call.id) : undefined;
		if (index === undefined) {
			if (!this.released) this.held.push(call);
			else {
				this.waiting.push(call);
				this.launchCovered();
			}
			return;
		}
		const entry = this.replay[index]!;
		if (entry.global !== undefined) {
			if (call.target !== "global" || call.name !== entry.global.name || !jsonEqual(call.args, entry.global.args)) {
				this.diverge(`call ${call.id} is ${describeCall(call)}, but was a call to ${entry.global.name}`);
				return;
			}
			this.ready.set(call.id, entry.global.outcome as CodemodeOutcome);
			void this.gate.promise.then(() => this.deliverReplay());
			return;
		}
		if (call.target !== "tool") {
			this.diverge(`call ${call.id} is ${describeCall(call)}, but was a tool call`);
			return;
		}
		void this.gate.promise
			.then(() => this.callTool(call))
			.then(
				(outcome) => {
					this.ready.set(call.id, outcome);
					this.deliverReplay();
				},
				(error) => {
					if (this.stopped) return;
					if (this.context.abortSignal?.aborted) this.fail(error);
					else this.diverge(`call ${call.id} is ${describeCall(call)}: ${errorMessage(error)}`);
				},
			);
	}
	private deliverReplay(): void {
		while (this.cursor < this.replay.length && !this.stopped) {
			const entry = this.replay[this.cursor]!;
			const result = this.ready.get(entry.id);
			if (entry.id > this.issued || result === undefined) return;
			this.ready.delete(entry.id);
			this.run!.deliver(++this.cursor, entry.at, entry.id, result);
		}
	}
	private idle(seq: number, issued: number): void {
		if (this.stopped) return;
		if (this.rerun && seq <= this.replay.length) {
			const previous = seq === 0 ? this.firstIssued : this.replay[seq - 1]!.issuedAfter;
			if (previous !== undefined && previous !== issued) {
				this.diverge(
					seq === 0
						? `its first run made ${issued} calls, where it had made ${previous}`
						: `after result ${seq} it had made ${issued} calls, where it had made ${previous}`,
				);
				return;
			}
		}
		this.acknowledgments.set(seq, issued);
		if (!this.replaying) {
			if (seq === 0 && this.rerun) void this.release();
			if (seq === this.length) void this.pump();
		} else if (seq === this.cursor) {
			const next = this.replay[seq];
			if (next !== undefined) {
				if (next.id > issued) this.diverge(`it waits without making call ${next.id}, which it made before`);
			} else {
				this.replaying = false;
				void this.pump();
				void this.release();
			}
		}
	}
	private async release(): Promise<void> {
		await this.gate.promise;
		if (this.stopped || this.released) return;
		const held = this.held.splice(0);
		if (this.rerun)
			for (const call of held) {
				let earlier: string | undefined;
				try {
					earlier = await this.earlier(call);
				} catch (error) {
					this.fail(error);
					return;
				}
				if (this.stopped) return;
				if (earlier !== undefined) {
					this.diverge(`call ${call.id} is ${describeCall(call)}, but was ${earlier}`);
					return;
				}
			}
		this.released = true;
		this.waiting.push(...held, ...this.held.splice(0));
		this.launchCovered();
	}
	private async earlier(call: CodemodeHostCall): Promise<string | undefined> {
		const task = (await this.api.snapshot(NestedCallDoc, this.api.taskId, `c${call.id}`, this.context))?.taskId;
		if (task === undefined) return undefined;
		const input = (await this.api.getTask(task, this.context))?.input as ToolTaskInput | undefined;
		if (input?.kind !== "nested") return undefined;
		if (call.target === "tool" && input.call.name === call.name && jsonEqual(input.call.arguments, call.args ?? {}))
			return undefined;
		return `tools.${input.call.name}(${JSON.stringify(input.call.arguments)})`;
	}
	private launchCovered(): void {
		if (!this.released || this.stopped) return;
		const admitted = this.waiting.filter((call) => call.id <= this.covered);
		this.waiting = this.waiting.filter((call) => call.id > this.covered);
		for (const call of admitted) this.launch(call);
	}
	private launch(call: CodemodeHostCall): void {
		if (this.stopped) return;
		const result: Promise<{ outcome: CodemodeOutcome; global?: Delivery["global"] }> =
			call.target === "tool"
				? this.callTool(call).then((outcome) => ({ outcome }))
				: this.callGlobal(call).then((outcome) => ({
						outcome,
						global: {
							name: call.name,
							...(call.args === undefined ? {} : { args: call.args as JsonValue }),
							outcome: outcome as JsonObject,
						},
					}));
		void result.then(
			(done) => {
				if (this.stopped) return;
				this.queue.push({ id: call.id, at: this.api.now(), ...done });
				void this.pump();
			},
			(error) => {
				if (this.stopped) return;
				if (this.context.abortSignal?.aborted) this.fail(error);
				else this.diverge(`call ${call.id} is ${describeCall(call)}: ${errorMessage(error)}`);
			},
		);
	}
	private async callTool(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		const model = call.name.startsWith(CODEMODE_INTERNAL_PREFIX);
		if (model) {
			await this.acquireModel();
			if (this.stopped) {
				this.releaseModel();
				throw new Error("The script has ended");
			}
		}
		let result: NestedToolExecutionResult;
		try {
			result = await this.api.executeTool(call.name, (call.args ?? {}) as JsonObject, this.context, {
				key: `c${call.id}`,
			});
		} finally {
			if (model) this.releaseModel();
		}
		if (call.name === GENERATE_IMAGES_TOOL) {
			const value = result.structuredOutput;
			if (value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.output))
				this.images += value.output.filter(
					(item) => item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "image",
				).length;
		}
		const outcome = toolOutcome(
			call.name,
			this.start.tools.find((tool) => tool.name === call.name)?.structured === true,
			result,
		);
		const row = this.rows.get(call.id);
		if (row !== undefined) {
			row.status = result.isError ? "error" : "ok";
			if (result.durationMs !== undefined) row.durationMs = result.durationMs;
			const error = outcome.ok
				? result.diagnostics
						.filter((note) => note.severity === "error")
						.map((note) => note.message)
						.join("\n")
				: outcome.message;
			if (result.isError && error) row.error = cut(error, 500);
		}
		return outcome;
	}
	private async acquireModel(): Promise<void> {
		if (this.modelCalls >= MAX_CONCURRENT_MODEL_CALLS)
			await new Promise<void>((resolve) => this.modelWaiters.push(resolve));
		this.modelCalls++;
	}
	private releaseModel(): void {
		this.modelCalls--;
		this.modelWaiters.shift()?.();
	}
	private async callGlobal(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		const discovery = discoveryNames.includes(call.name);
		const catalog = CATALOG_GLOBALS.some((name) => name === call.name);
		const global = discovery || catalog ? undefined : this.options.globals?.find((global) => global.name === call.name);
		if (!discovery && !catalog && global === undefined) return { ok: false, message: `Unknown global ${call.name}` };
		try {
			return {
				ok: true,
				value: discovery
					? this.discover(call)
					: catalog
						? await catalogCall(call.name, call.args, this.api.models, this.context)
						: await global!.execute(call.args, this.api, this.context),
			};
		} catch (error) {
			if (this.context.abortSignal?.aborted) throw error;
			return { ok: false, message: errorMessage(error) };
		}
	}
	private discover(call: CodemodeHostCall): JsonValue | undefined {
		const args: unknown[] = Array.isArray(call.args) ? call.args : [];
		const tools = this.start.tools.filter((tool) => !tool.hidden);
		const namespaces = this.start.namespaces;
		const matches = (namespace: Start["namespaces"][number], name: string) =>
			namespace.name === name || toCodemodeIdentifier(namespace.name) === toCodemodeIdentifier(name);
		if (call.name === "describeTool") {
			if (typeof args[0] !== "string") throw new Error("describeTool() expects a tool name");
			return tools.find((tool) => tool.name === args[0] || tool.jsName === args[0])?.description;
		}
		if (call.name === "describeNamespace") {
			const name = args[0];
			if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
			const namespace = namespaces.find((namespace) => matches(namespace, name));
			return namespace === undefined
				? undefined
				: {
						name: namespace.name,
						...(namespace.description === undefined ? {} : { description: namespace.description }),
						...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
						tools: namespace.tools.map(toCodemodeIdentifier),
					};
		}
		const [query, options] = args;
		if (typeof query !== "string") throw new Error("searchTools() expects a query string");
		const option = (key: string): unknown =>
			options !== null && options !== undefined ? Reflect.get(Object(options), key) : undefined;
		const limit = option("limit") ?? 8;
		const namespace = option("namespace");
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
			throw new Error("searchTools() limit must be a positive integer");
		if (namespace !== undefined && namespace !== null && typeof namespace !== "string")
			throw new Error("searchTools() namespace must be a string");
		const documents = tools.flatMap((tool) => {
			const own = namespaces.find((namespace) => namespace.tools.includes(tool.name));
			if (typeof namespace === "string" && (!own || !matches(own, namespace))) return [];
			return [
				{
					name: tool.name,
					text: [
						tool.name,
						tool.name.replaceAll("_", " "),
						tool.description,
						own?.name ?? "",
						own?.description ?? "",
					].join(" "),
				},
			];
		});
		return rankDocuments(query, documents, limit).map((name) => {
			const tool = tools.find((tool) => tool.name === name)!;
			return { name: tool.jsName, description: tool.description };
		});
	}
	private async pump(): Promise<void> {
		if (this.saving || this.stopped || (!this.queue.length && !this.acknowledgments.size)) return;
		this.saving = true;
		const batch = this.queue.splice(0);
		const acknowledgments = [...this.acknowledgments];
		this.acknowledgments.clear();
		try {
			await this.api.commit(async (tx) => {
				const journal = await tx.doc(CodemodeJournalDoc, this.api.taskId);
				for (const [seq, issued] of acknowledgments) {
					if (seq === 0) journal.firstIssued ??= issued;
					else {
						const entry = journal.entries[seq - 1];
						if (entry !== undefined) entry.issuedAfter ??= issued;
					}
				}
				for (const item of batch)
					journal.entries.push(
						clone({ id: item.id, at: item.at, ...(item.global === undefined ? {} : { global: item.global }) }),
					);
			}, this.context);
		} catch (error) {
			this.fail(error);
			return;
		}
		for (const [, issued] of acknowledgments) this.covered = Math.max(this.covered, issued);
		for (const item of batch) {
			this.length++;
			if (!this.run!.finished) this.run!.deliver(this.length, item.at, item.id, item.outcome);
		}
		this.launchCovered();
		this.saving = false;
		void this.pump();
	}
}
