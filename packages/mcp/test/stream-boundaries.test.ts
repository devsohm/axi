import { expect, test } from "vitest";
import { JsonRpcLineReader } from "../src/transports/lines.ts";
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";
import {
	parseAuthorizationServerMetadata,
	parseClientInformation,
	parseOAuthTokens,
	parseProtectedResourceMetadata,
} from "../src/oauth/types.ts";

function chunks(values: readonly Uint8Array[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const value of values) controller.enqueue(value);
			controller.close();
		},
	});
}

test("SSE preserves split UTF-8, multiline data, retry hints and IDs while rejecting invalid hint fields", async () => {
	const events: SseEvent[] = [],
		ids: string[] = [],
		delays: number[] = [];
	const bytes = Buffer.from(
		": keepalive\r\nid: cursor-1\r\nretry: 25\r\nretry: -1\r\nretry: nope\r\nevent: message\r\ndata: 界\r\ndata: 🙂\r\n\r\nid: invalid\0id\nunknown\ndata\n\ndata: tail",
	);
	const stream = chunks([...bytes].map((byte) => Uint8Array.of(byte)));
	await consumeSseStream(stream, {
		onEvent: (event) => events.push(event),
		onId: (id) => ids.push(id),
		onRetry: (delay) => delays.push(delay),
	});
	expect(events).toEqual([{ event: "message", id: "cursor-1", data: "界\n🙂" }, { data: "" }, { data: "tail" }]);
	expect(ids).toEqual(["cursor-1"]);
	expect(delays).toEqual([25]);
	expect(stream.locked).toBe(false);
});

test("SSE bounds both unterminated lines and combined data and releases a failed stream", async () => {
	for (const input of ["data: too long", "data: 1234\ndata: 5678\n\n"]) {
		let cancelled = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Buffer.from(input));
			},
			cancel() {
				cancelled++;
				throw new Error("socket already gone");
			},
		});
		await expect(
			consumeSseStream(stream, {
				maxEventBytes: 8,
				onEvent() {
					throw new Error("oversized event delivered");
				},
			}),
		).rejects.toThrow(/exceeds 8 bytes/);
		expect(cancelled).toBe(1);
		expect(stream.locked).toBe(false);
	}
});

test("line framing bounds unfinished messages, ignores whitespace and recovers for the next valid message", () => {
	const messages: unknown[] = [],
		errors: unknown[] = [];
	const reader = new JsonRpcLineReader({
		maxMessageBytes: 64,
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error),
	});
	reader.readStdout(Buffer.from(" \r\n\t\n"));
	reader.readStdout(Buffer.from("x".repeat(65)));
	reader.readStdout(Buffer.from("x".repeat(65) + "\n"));
	reader.readStdout(Buffer.from('[]\n{"jsonrpc":"2.0","method":"ready"}\r\n'));
	reader.readStdout(Buffer.from(" \t"));
	reader.end();
	expect(messages).toEqual([{ jsonrpc: "2.0", method: "ready" }]);
	expect(errors).toHaveLength(3);
	for (const error of errors) expect(error).toBeInstanceOf(Error);
});

test("OAuth metadata parsers reject malformed fields and retain supported extension data", () => {
	const issuer = "https://issuer.example",
		base = {
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			response_types_supported: ["code"],
		};
	for (const raw of [
		null,
		[],
		"text",
		{ ...base, response_types_supported: undefined },
		{ ...base, scopes_supported: 3 },
		{ ...base, authorization_endpoint: "file:///secret" },
		{ ...base, registration_endpoint: "not a URL" },
	])
		expect(() => parseAuthorizationServerMetadata(raw)).toThrow();
	expect(
		parseAuthorizationServerMetadata({
			...base,
			client_id_metadata_document_supported: true,
			authorization_response_iss_parameter_supported: true,
			custom: "extension",
		}),
	).toMatchObject({
		...base,
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
		custom: "extension",
	});
	for (const raw of [
		{},
		{ resource: "file:///secret" },
		{ resource: issuer, authorization_servers: [3] },
		{ resource: issuer, authorization_servers: ["data:secret"] },
	])
		expect(() => parseProtectedResourceMetadata(raw)).toThrow();
	expect(parseProtectedResourceMetadata({ resource: issuer, authorization_servers: [issuer], custom: 1 })).toEqual({
		resource: issuer,
		authorization_servers: [issuer],
		custom: 1,
	});
	const client = {
		client_id: "client",
		client_secret: "secret",
		client_id_issued_at: 12,
		client_secret_expires_at: 20,
		redirect_uris: ["my-app://callback"],
	};
	expect(parseClientInformation(client)).toEqual(client);
	expect(parseClientInformation({ client_id: "client" })).toEqual({ client_id: "client", redirect_uris: [] });
	for (const raw of [{}, { client_id: "" }, { client_id: "client", redirect_uris: [4] }])
		expect(() => parseClientInformation(raw)).toThrow();
	for (const raw of [
		null,
		{},
		{ access_token: "token" },
		{ access_token: "token", token_type: "Bearer", expires_in: "forever" },
		{ access_token: "token", token_type: "Bearer", scope: 1 },
	])
		expect(() => parseOAuthTokens(raw)).toThrow();
	expect(
		parseOAuthTokens({ access_token: "token", token_type: "Bearer", expires_in: "30", scope: "", refresh_token: null }),
	).toEqual({ access_token: "token", token_type: "Bearer", expires_in: 30 });
});
