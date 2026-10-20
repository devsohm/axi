import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defaultProviderAuthContext } from "../src/auth/context.ts";
import { flattenChatModelCatalog } from "../src/model-catalog.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { ModelsError } from "../src/models.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage, Tool, Usage } from "../src/types.ts";
import { combineAbortSignals } from "../src/utils/abort-signals.ts";
import { raceWithAbortSignal } from "../src/utils/abort.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";
import { extractDiagnosticError } from "../src/utils/diagnostics.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../src/utils/headers.ts";
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { uuidv7 } from "../src/utils/uuid.ts";
import {
	getCurrentSystemPrompt,
	getCurrentSystemMessage,
	getCurrentTools,
	getToolStateChanges,
	normalizeContext,
	resolveTranscriptTools,
} from "../src/utils/transcript.ts";

describe("AI foundations", () => {
	it("rejects a null UUID timestamp supplied by an untyped caller", () => {
		expect(() => uuidv7(JSON.parse("null"))).toThrow("Cannot convert null to a BigInt");
	});
	it("preserves a diagnostic code supplied by an error proxy", () => {
		const error = new Proxy(new Error("Throttled"), {
			has: () => false,
			get(target, key, receiver) {
				return key === "code" ? 429 : Reflect.get(target, key, receiver);
			},
		});
		expect(extractDiagnosticError(error)).toMatchObject({ name: "Error", message: "Throttled", code: 429 });
	});
	it("checks the provider body before capturing the displayed message", () => {
		let reads = 0;
		const error = new Error();
		Object.assign(error, { status: 400, body: "raw-body" });
		Object.defineProperty(error, "message", {
			get() {
				return ++reads === 1 ? "raw-body" : "rendered-message";
			},
		});
		expect(normalizeProviderError(error)).toEqual({
			status: 400,
			body: "raw-body",
			message: "rendered-message",
			messageCarriesBody: true,
		});
	});
	it("captures cause detail once before native error construction", () => {
		let reads = 0;
		const error = new ModelsError("stream", "Failed", {
			get cause() {
				return `cause-${++reads}`;
			},
		});
		expect({ reads, message: error.message, cause: error.cause }).toEqual({
			reads: 2,
			message: "Failed: cause-1",
			cause: "cause-2",
		});
	});
	it.each(["aborted", "toolUse", "error"] as const)(
		"does not inspect usage for a %s response during overflow detection",
		(stopReason) => {
			const message: AssistantMessage = {
				...fauxAssistantMessage([], { stopReason, errorMessage: "unrelated failure" }),
				get usage(): Usage {
					throw new Error("unused usage read");
				},
			};
			expect(isContextOverflow(message, 100)).toBe(false);
		},
	);
	it.each(["stop", "length", "toolUse", "aborted"] as const)(
		"does not inspect error text for a %s response during overflow detection",
		(stopReason) => {
			const message: AssistantMessage = {
				...fauxAssistantMessage([], { stopReason }),
				get errorMessage(): string {
					throw new Error("unused error read");
				},
			};
			expect(isContextOverflow(message, 100)).toBe(false);
		},
	);
	it("checks generated output before inspecting input for a length stop", () => {
		const message = fauxAssistantMessage([], { stopReason: "length" });
		message.usage = {
			...message.usage,
			output: 1,
			get input(): number {
				throw new Error("unused input read");
			},
		};
		expect(isContextOverflow(message, 100)).toBe(false);
	});
	it("treats a process shim without an environment as an absent credential source", async () => {
		const saved = globalThis.process;
		let result: Promise<string | undefined>;
		try {
			Reflect.set(globalThis, "process", {});
			result = defaultProviderAuthContext().env("ABSENT");
		} finally {
			Reflect.set(globalThis, "process", saved);
		}
		await expect(result).resolves.toBeUndefined();
	});
	it("times a final response unless its timestamp predates the stream", async () => {
		const stream = new AssistantMessageEventStream();
		const message = fauxAssistantMessage([], { timestamp: Number.NaN });
		stream.end(message);
		expect((await stream.result()).durationMs).toBeGreaterThanOrEqual(0);
	});
	it("leaves an untimed system record without tool declarations out of the replayed prompt", () => {
		const record = { role: "system", content: "untimed" };
		expect(getCurrentSystemMessage([record])).toBeUndefined();
	});
	it("replays prompt sections and tool removals without changing the transcript", () => {
		const read: Tool = { name: "read", description: "Read a resource", parameters: Type.Object({}) };
		const write: Tool = { name: "write", description: "Write a resource", parameters: Type.Object({}) };
		const context = normalizeContext({
			messages: [
				{ role: "system", content: "Base", sections: { rules: "Old", help: "Help" }, toolsAdded: [read], timestamp: 0 },
				{ role: "user", content: "Go", timestamp: 1 },
				{
					role: "system",
					content: "Update",
					sections: { rules: "New", help: null },
					toolsRemoved: [{ name: "read" }],
					toolsAdded: [write],
					timestamp: 2,
				},
			],
		});
		expect(getCurrentSystemPrompt(context.messages)).toBe("Base\n\nUpdate\n\nNew");
		expect(getCurrentTools(context.messages)).toEqual([write]);
		expect(resolveTranscriptTools(context.messages, "additions")).toEqual({
			foldedSystemMessages: 2,
			requestTools: [write],
		});
		expect(getToolStateChanges([read], [write])).toEqual({ toolsAdded: [write], toolsRemoved: [{ name: "read" }] });
		expect(context.messages[0]).toMatchObject({ content: "Base", sections: { rules: "Old", help: "Help" } });
	});
	it("does not treat an incomplete object as finished tool arguments", () => {
		expect(parseStreamingJson('{"file":"a.ts",')).toEqual({ file: "a.ts" });
		const complete = parseToolCallArguments('{"file":"a.ts",');
		expect(complete.arguments).toEqual({});
		expect(complete.argumentsError).toContain('Received arguments:\n{"file":"a.ts",');
		expect(parseToolCallArguments('{"text":"a\nb"}')).toEqual({ arguments: { text: "a\nb" } });
	});
	it("merges header names without retaining a suppressed value", () => {
		expect(
			providerHeadersToRecord(
				{ Authorization: "old", Accept: "json" },
				{ authorization: null, ACCEPT: "text", Custom: "value" },
			),
		).toEqual({ ACCEPT: "text", Custom: "value" });
	});
	it("returns response headers with ordinary record assignment semantics", () => {
		const headers = headersToRecord(
			new Headers([
				["__proto__", "ignored"],
				["x-test", "kept"],
			]),
		);
		expect(headers).toEqual({ "x-test": "kept" });
		expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
	});
	it("aborts a pending operation with the original reason and observes its later rejection", async () => {
		const abort = new AbortController(),
			pending = Promise.withResolvers<number>();
		const rejected = raceWithAbortSignal(pending.promise, abort.signal).catch((value) => value);
		const reason = { cancelled: true };
		abort.abort(reason);
		expect(await rejected).toBe(reason);
		pending.reject(new Error("late"));
		await Promise.resolve();
	});
	it("releases combined signal listeners on cleanup", () => {
		const first = new AbortController(),
			second = new AbortController();
		const joined = combineAbortSignals([undefined, first.signal, second.signal]);
		second.abort("stop");
		expect(joined.signal?.reason).toBe("stop");
		const detached = combineAbortSignals([first.signal, new AbortController().signal]);
		detached.cleanup();
		first.abort("later");
		expect(detached.signal?.aborted).toBe(false);
	});
	it("preserves FIFO through a large buffered response", async () => {
		const stream = new EventStream<number, number>(
			(value) => value === 4095,
			(value) => value,
		);
		for (let value = 0; value < 4096; value++) stream.push(value);
		const values: number[] = [];
		for await (const value of stream) values.push(value);
		expect(values).toEqual(Array.from({ length: 4096 }, (_, value) => value));
		expect(await stream.result()).toBe(4095);
	});
	it("stores detached model snapshots and rejects cancelled reads", async () => {
		const store = new InMemoryModelsStore();
		const entry = { models: [], etag: '"first"' };
		await store.write("test", entry);
		entry.etag = '"changed"';
		expect(await store.read("test")).toEqual({ models: [], etag: '"first"' });
		const controller = new AbortController();
		controller.abort("cancel");
		await expect(store.read("test", { signal: controller.signal })).rejects.toBe("cancel");
	});
	it("adds trailing estimates to reported usage without counting stale responses", () => {
		const usage: Usage = {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(
			estimateContextTokens(
				normalizeContext({
					messages: [
						{
							role: "assistant",
							api: "test",
							provider: "test",
							model: "test",
							content: [],
							usage,
							stopReason: "stop",
							timestamp: 1,
						},
						{ role: "user", content: "x".repeat(35), timestamp: 2 },
					],
				}),
			),
		).toEqual({ tokens: 220, usageTokens: 210, trailingTokens: 10, lastUsageIndex: 0 });
	});
	it("uses the selected usage record after inspecting the complete prefix", () => {
		const usage: Usage = {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = { ...fauxAssistantMessage([], { timestamp: 1 }), usage };
		expect(
			estimateContextTokens([
				assistant,
				{
					role: "user",
					content: "hello",
					get timestamp() {
						usage.totalTokens = 100;
						return 2;
					},
				},
			]),
		).toEqual({ tokens: 102, usageTokens: 100, trailingTokens: 2, lastUsageIndex: 0 });
	});
	it("selects catalog model types before resolving their identities", () => {
		const reads: string[] = [];
		const first = {
			get type() {
				reads.push("first.type");
				return "chat";
			},
			get id() {
				reads.push("first.id");
				return "first";
			},
		};
		const second = {
			get type() {
				reads.push("second.type");
				return "chat";
			},
			get id() {
				reads.push("second.id");
				return "second";
			},
		};
		const catalog = flattenChatModelCatalog("test", { api: { "chat:first": first, "chat:second": second } });
		expect(reads).toEqual(["first.type", "second.type", "first.id", "second.id"]);
		expect(catalog.first).toBe(first);
		expect(catalog.second).toBe(second);
	});
});
