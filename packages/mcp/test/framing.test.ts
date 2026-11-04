import { expect, test } from "vitest";
import { JsonRpcLineReader } from "../src/transports/lines.ts";
import { consumeSseStream } from "../src/transports/streamable-http.ts";

test("a line reader owns pending bytes when the transport reuses its read buffer", () => {
	const messages: unknown[] = [];
	const errors: unknown[] = [];
	const reader = new JsonRpcLineReader({
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error),
	});
	const first = Buffer.from('{"jsonrpc":"2.0","method":"one');
	reader.readStdout(first);
	first.fill(0);
	reader.readStdout(Buffer.from('"}\r\n{"jsonrpc":"2.0","method":"two"}\n'));
	reader.end();
	expect(errors).toEqual([]);
	expect(messages).toEqual([
		{ jsonrpc: "2.0", method: "one" },
		{ jsonrpc: "2.0", method: "two" },
	]);
});

test("SSE dispatches CR-delimited events while open and absorbs split CRLF once", async () => {
	const events: unknown[] = [];
	const dispatched = Promise.withResolvers<void>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const consuming = consumeSseStream(stream, {
		onEvent(event) {
			events.push(event);
			dispatched.resolve();
		},
	});
	controller.enqueue(Buffer.from("data: first\r"));
	controller.enqueue(Buffer.from("\ndata: second\r\r"));
	await dispatched.promise;
	expect(events).toEqual([{ data: "first\nsecond" }]);
	controller.enqueue(Buffer.from("data: third\r\n\r\n"));
	controller.close();
	await consuming;
	expect(events).toEqual([{ data: "first\nsecond" }, { data: "third" }]);
});
