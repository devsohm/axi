import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@axi/telemetry";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	TODO_CONTEXT,
	traceIn,
	createContextKey,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	withTelemetry,
} from "../src/context/index.ts";

describe("invocation contexts", () => {
	it("keeps request values and cancellation while deriving telemetry children", async () => {
		const recorder = new InMemoryTelemetryContext();
		const key = createContextKey<string>("owner");
		const { context: cancelled, cancel } = withCancel(withContextValue(key, "local", BACKGROUND_CONTEXT));
		await recorder.startSpan({ name: "caller" }, async (span) => {
			const context = withTelemetry(span, cancelled);
			cancel("stop");
			expect(cancelled.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
			expect(withoutAbortSignal(context).telemetry).toBe(span);
			expect(
				await traceIn(context, { name: "outer" }, async (child) => {
					expect(child.value(key)).toBe("local");
					expect(child.abortSignal?.reason).toBe("stop");
					return traceIn(child, { name: "inner" }, (nested) => {
						nested.telemetry.addLink({ context: child.telemetry });
						return 42;
					});
				}),
			).toBe(42);
			const [caller, outer, inner] = recorder.getSpans();
			expect(outer.parentId).toBe(caller.id);
			expect(inner.parentId).toBe(outer.id);
			expect(inner.links).toEqual([{ context: outer.context, attributes: {} }]);
			expect(context.telemetry).toBe(span);
		});
	});
	it("shares prototype methods without adding own enumerable properties", () => {
		const key = createContextKey<number>("job");
		const first = withContextValue(key, 1, BACKGROUND_CONTEXT);
		const second = withContextValue(key, 2, BACKGROUND_CONTEXT);
		expect(Object.keys(BACKGROUND_CONTEXT)).toEqual([]);
		expect(Object.keys(first)).toEqual([]);
		expect(BACKGROUND_CONTEXT.value).toBe(TODO_CONTEXT.value);
		expect(first.value).toBe(second.value);
		expect(first.toString).toBe(second.toString);
		expect(first.value(key)).toBe(1);
		expect(second.value(key)).toBe(2);
	});
	it("captures an abort reason with a single read", async () => {
		let reads = 0;
		const expected = new Error("cancelled");
		class Signal extends AbortSignal {
			override get reason(): unknown {
				return ++reads === 1 ? expected : undefined;
			}
		}
		const controller = new AbortController();
		Object.setPrototypeOf(controller.signal, Signal.prototype);
		controller.abort();
		await expect(
			awaitWithContext(Promise.resolve(1), withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
		).rejects.toBe(expected);
		expect(reads).toBe(1);
	});
	it("distinguishes equal key descriptions and shadows values without changing a parent", () => {
		const key = createContextKey<string | undefined>("request");
		const other = createContextKey<string>("request");
		const parent = withContextValue(key, "first", BACKGROUND_CONTEXT);
		const child = withContextValue(key, undefined, parent);
		expect(parent.value(key)).toBe("first");
		expect(parent.value(other)).toBeUndefined();
		expect(child.value(key)).toBeUndefined();
		expect(Object.isFrozen(key)).toBe(true);
		expect(String(parent)).toBe("[Context BACKGROUND_CONTEXT].WithValue(request)");
	});

	it("preserves the original promise when no cancellation is configured", async () => {
		const work = Promise.resolve(42);
		expect(awaitWithContext(work, BACKGROUND_CONTEXT)).toBe(work);
		await expect(work).resolves.toBe(42);
	});

	it("removes cancellation listeners before reporting success or failure", async () => {
		const controller = new AbortController();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		await expect(awaitWithContext(Promise.resolve("ready"), context)).resolves.toBe("ready");
		expect(getEventListeners(controller.signal, "abort")).toEqual([]);
		const failure = new Error("failed work");
		await expect(awaitWithContext(Promise.reject(failure), context)).rejects.toBe(failure);
		expect(getEventListeners(controller.signal, "abort")).toEqual([]);
	});

	it("cancels a waiter while allowing the underlying work to finish", async () => {
		const child = withCancel(BACKGROUND_CONTEXT);
		const work = Promise.withResolvers<number>();
		const waiting = awaitWithContext(work.promise, child.context);
		child.cancel("stop waiting");
		await expect(waiting).rejects.toMatchObject({ name: "AbortError", message: "The operation was aborted" });
		work.resolve(7);
		await expect(work.promise).resolves.toBe(7);
	});

	it("preserves values when cancellation is masked for cleanup", () => {
		const key = createContextKey<number>("job");
		const parent = withCancel(withContextValue(key, 9, BACKGROUND_CONTEXT));
		const sibling = withCancel(parent.context);
		const cleanup = withoutAbortSignal(parent.context);
		parent.cancel("parent stopped");
		expect(sibling.context.abortSignal?.reason).toBe("parent stopped");
		expect(cleanup.abortSignal).toBeUndefined();
		expect(cleanup.value(key)).toBe(9);
	});
});
