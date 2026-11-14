import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../src/context/index.ts";
import { Activity } from "../src/host/activity.ts";
import { NativeHandle } from "../src/host/native.ts";
import { ParkedCalls } from "../src/host/parked.ts";
import { RevocationKeys } from "../src/host/revocation.ts";
import { UnboundIndex } from "../src/host/unbound.ts";
import { Batch, type BatchError } from "../src/state/internal.ts";

it("keeps a reindexed request for the next publication and leaves other names waiting", () => {
	const index = new UnboundIndex();
	const calls: string[] = [];
	const note = {
		principal: undefined,
		end() {},
		wake() {
			calls.push("note");
			index.add("notes", note);
		},
	};
	const task = {
		principal: undefined,
		end() {},
		wake() {
			calls.push("task");
		},
	};
	index.add("notes", note);
	index.add("tasks", task);
	index.wake(["notes", "notes"]);
	expect(calls).toEqual(["note"]);
	index.wake(["notes"]);
	expect(calls).toEqual(["note", "note"]);
	expect(index.delete("notes", note)).toBe(true);
	index.wakeAll();
	expect(calls).toEqual(["note", "note", "task"]);
});

it("reports listener failures through a discriminated error type", () => {
	const failure = new Error("listener failed"),
		errors: unknown[] = [];
	const record = (error: Extract<BatchError, { readonly kind: "listener_error" }>): void => {
		errors.push(error.error);
	};
	const batch = new Batch((error) => {
		if (error.kind === "listener_error") record(error);
	}, undefined);
	batch.reportListener(failure);
	expect(errors).toEqual([failure]);
});

it("closes a resource that arrives after its opener was abandoned", async () => {
	const gate = Promise.withResolvers<string>(),
		events: unknown[] = [],
		reports: unknown[] = [];
	const resource = new NativeHandle(
		() => gate.promise,
		(value, reason, context) => {
			events.push([value, reason.kind, context.abortSignal?.aborted]);
		},
		100,
		{
			object: "app",
			type: "app",
			host: "client",
			position: 1,
			context,
			report: (error) => reports.push(error),
		},
	);
	expect(() => resource.value).toThrow("not open yet");
	const opening = resource.open(context);
	await resource.close({ kind: "close" });
	gate.resolve("late");
	await opening;
	expect(events).toEqual([["late", "close", false]]);
	expect(() => resource.value).toThrow("app native #1: closed");
	expect(reports).toEqual([]);
});

it("reports a native close timeout, aborts its close context, and frees its timer", async () => {
	vi.useFakeTimers();
	try {
		const reports: unknown[] = [],
			finish = Promise.withResolvers<void>();
		let closingSignal: AbortSignal | undefined;
		const resource = new NativeHandle(
			async () => 4,
			(_value, _reason, context) => {
				closingSignal = context.abortSignal;
				return finish.promise;
			},
			10,
			{
				object: "app",
				type: "app",
				host: "client",
				position: 1,
				context,
				report: (error) => reports.push(error),
			},
		);
		await resource.open(context);
		expect(resource.value).toBe(4);
		const closing = resource.close({ kind: "end" });
		await vi.advanceTimersByTimeAsync(10);
		await closing;
		expect(reports).toEqual([
			{
				kind: "close_timeout",
				object: "app",
				native: { kind: "native", position: 1 },
			},
		]);
		expect(closingSignal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		finish.resolve();
	} finally {
		vi.useRealTimers();
	}
});

it("removes cancelled calls and applies each queued call's deadline when flushing", async () => {
	vi.useFakeTimers();
	try {
		const calls = new ParkedCalls(20, "app"),
			cancel = withCancel(context),
			sent: string[] = [];
		const cancelled = calls.park("cancelled", {}, cancel.context);
		cancel.cancel(new Error("cancel"));
		await expect(cancelled).rejects.toThrow("cancel");
		const first = calls.park("first", {}, context),
			second = calls.park("second", {}, context);
		const rejected = expect(second).rejects.toMatchObject({
			code: "unavailable",
			reason: "park_timeout",
		});
		calls.flush(
			async (method) => {
				sent.push(method);
				vi.setSystemTime(Date.now() + 30);
				return 7;
			},
			() => true,
		);
		expect(await first).toBe(7);
		await rejected;
		expect(sent).toEqual(["first"]);
		expect(calls.waiting).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

it("coalesces activity changes into one immutable snapshot per turn", async () => {
	const batch = new Batch(() => {}, undefined),
		activity = new Activity(batch),
		seen: unknown[] = [];
	const watch = await activity.watch(context),
		initial = watch.value;
	watch.start(async (call) => {
		if (call.kind === "value") seen.push(call.value);
	});
	activity.count("calls", 1);
	activity.count("jobs", 1);
	activity.count("calls", -1);
	await new Promise((resolve) => setImmediate(resolve));
	activity.count("jobs", -1);
	await new Promise((resolve) => setImmediate(resolve));
	expect(initial).toEqual({ calls: 0, jobs: 0, references: 0, lingering: 0 });
	expect(seen).toEqual([
		{ calls: 0, jobs: 1, references: 0, lingering: 0 },
		{ calls: 0, jobs: 0, references: 0, lingering: 0 },
	]);
	await watch.stop();
});

it("computes revocation keys once per principal and compares canonical JSON", () => {
	let read = 0;
	const keys = new RevocationKeys((principal) => {
		read++;
		return [{ group: principal.kind, id: 1 }];
	});
	const principal = { kind: "member" };
	expect(keys.revokes(principal, '{"group":"member","id":1}', context)).toBe(true);
	expect(keys.revokes(principal, '{"group":"other","id":1}', context)).toBe(false);
	expect(read).toBe(1);
});
