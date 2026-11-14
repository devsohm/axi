import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/objects/context";
import { Connection, type Reply, type RequestOptions, RemoteError } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { RemoteTerminal, openTerminal } from "../src/terminal.ts";
import { openProcess } from "../src/process.ts";
import { localDaemon } from "../src/ssh.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const empty = new Uint8Array();
const done: Reply = { json: { exitCode: 0 }, payload: empty, session: 7 };

test("execution ignores progress, empty output and output after completion", async () => {
	const connection = new Connection({ command: [] });
	const env = new RemoteExecutionEnv({ connection, id: "event-order", cwd: "/project" });
	let emit: RequestOptions["onEvent"];
	vi.spyOn(connection, "request").mockImplementationOnce(async (_op, _json, options) => {
		emit = options?.onEvent;
		options?.onStart?.(1, 7);
		emit?.({ kind: "progress" }, Buffer.from("not output"));
		emit?.({ kind: "output" }, empty);
		emit?.({ kind: "output", stream: "stderr" }, Buffer.from("diagnostic"));
		return done;
	});
	const output = vi.fn();
	try {
		expect(await env.exec("ignored by peer", { onOutput: output }, context)).toMatchObject({ ok: true });
		emit?.({ kind: "output" }, Buffer.from("late"));
		expect(output.mock.calls.map(([text, _context, info]) => [text, info])).toEqual([
			["diagnostic", { stream: "stderr" }],
		]);
	} finally {
		connection.close();
	}
});

test("execution without an output handler still completes when output arrives", async () => {
	const connection = new Connection({ command: [] });
	const env = new RemoteExecutionEnv({ connection, id: "no-handler", cwd: "/project" });
	vi.spyOn(connection, "request").mockImplementationOnce(async (_op, _json, options) => {
		options?.onEvent?.({ kind: "output" }, Buffer.from("discarded"));
		return done;
	});
	try {
		expect(await env.exec("ignored by peer", undefined, context)).toMatchObject({ ok: true, value: { exitCode: 0 } });
	} finally {
		connection.close();
	}
});

test.each([new Error("Consumer failed"), "Consumer failed"])(
	"a callback failure %j wins over a completed peer response",
	async (cause) => {
		const connection = new Connection({ command: [] });
		const env = new RemoteExecutionEnv({ connection, id: "callback-priority", cwd: "/project" });
		vi.spyOn(connection, "request").mockImplementationOnce(async (_op, _json, options) => {
			options?.onEvent?.({ kind: "output" }, Buffer.from("first"));
			options?.onEvent?.({ kind: "output" }, Buffer.from("second"));
			return done;
		});
		const callback = vi.fn(() => {
			throw cause;
		});
		try {
			expect(await env.exec("ignored by peer", { onOutput: callback }, context)).toMatchObject({
				ok: false,
				error: { code: "callback_error", message: "Consumer failed" },
			});
			expect(callback).toHaveBeenCalledTimes(1);
		} finally {
			connection.close();
		}
	},
);

test("an earlier cancellation retains its classification while the peer delays acknowledgement past the deadline", async () => {
	vi.useFakeTimers();
	const connection = new Connection({ command: [] });
	const env = new RemoteExecutionEnv({ connection, id: "deferred-cancel", cwd: "/project" });
	const pending = Promise.withResolvers<Reply>();
	const controller = new AbortController();
	vi.spyOn(connection, "request").mockReturnValueOnce(pending.promise);
	try {
		const result = env.exec("ignored by peer", { timeout: 0.025 }, withAbortSignal(controller.signal, context));
		controller.abort();
		await vi.advanceTimersByTimeAsync(25);
		pending.reject(new RemoteError({ code: "aborted", message: "cancelled by peer" }));
		expect(await result).toMatchObject({ ok: false, error: { code: "aborted", message: "aborted" } });
	} finally {
		connection.close();
	}
});

test("terminal foreground information can have a PID without a display name", async () => {
	const connection = new Connection({ command: [] });
	vi.spyOn(connection, "request").mockResolvedValueOnce({ ...done, json: { foreground: { pid: 91, name: null } } });
	const terminal = new RemoteTerminal(connection, 1, 7, 90, Promise.resolve(0), new AbortController());
	try {
		expect(await terminal.foreground()).toEqual({ pid: 91 });
	} finally {
		terminal.close();
		connection.close();
	}
});

test.each(["process", "terminal"] as const)(
	"unrelated %s events do not produce output or prevent startup",
	async (kind) => {
		const connection = new Connection({ command: [localDaemon()] });
		const exit = Promise.withResolvers<Reply>();
		const output = vi.fn();
		const request = vi.spyOn(connection, "request").mockImplementationOnce(async (_op, _json, options) => {
			await Promise.resolve();
			options?.onStart?.(1, 7);
			options?.onEvent?.({ kind: "progress" }, empty);
			options?.onEvent?.({ kind: "started", pid: 90 }, empty);
			return exit.promise;
		});
		try {
			const handle =
				kind === "terminal"
					? await openTerminal(connection, { cwd: "/project", cols: 80, rows: 24, onData: output })
					: await openProcess(connection, { cwd: "/project", argv: ["ignored by peer"], onStdout: output });
			expect(handle.pid).toBe(90);
			expect(output).not.toHaveBeenCalled();
			exit.resolve(done);
			expect(await handle.exited).toBe(0);
			handle.close();
		} finally {
			exit.resolve(done);
			request.mockRestore();
			connection.close();
		}
	},
);
