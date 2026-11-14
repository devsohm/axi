import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { expect, test } from "vitest";
import { stream, streamSimple } from "../src/api/bedrock-converse-stream.ts";
import type { Model, ProviderResponse } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

test.each(["full", "simple", "callback failure"] as const)(
	"Bedrock %s uses the native SDK transport and reports response headers once",
	async (mode) => {
		const codec = new EventStreamCodec(
			(bytes) => new TextDecoder().decode(bytes),
			(text) => new TextEncoder().encode(text),
		);
		const frames = Object.entries({
			messageStart: { role: "assistant" },
			contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ready" } },
			contentBlockStop: { contentBlockIndex: 0 },
			messageStop: { stopReason: "end_turn" },
			metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
		}).map(([type, value]) =>
			codec.encode({
				headers: {
					":message-type": { type: "string", value: "event" },
					":event-type": { type: "string", value: type },
					":content-type": { type: "string", value: "application/json" },
				},
				body: new TextEncoder().encode(JSON.stringify(value)),
			}),
		);
		const requests: { path: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
				response.writeHead(200, {
					"content-type": "application/vnd.amazon.eventstream",
					"x-amzn-requestid": "offline-request",
					"x-custom-response": "received",
				});
				response.end(Buffer.concat(frames));
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const replies: ProviderResponse[] = [];
		try {
			const model: Model<"bedrock-converse-stream"> = {
				api: "bedrock-converse-stream",
				provider: "bedrock",
				id: "sample-model",
				name: "Sample",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 1024,
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const result = await (mode === "simple" ? streamSimple : stream)(
				model,
				normalizeContext({
					messages: [{ role: "user", content: "hello", timestamp: 0 }],
				}),
				{
					env: {
						AWS_BEDROCK_SKIP_AUTH: "1",
						AWS_BEDROCK_FORCE_HTTP1: "1",
						AWS_REGION: "us-east-1",
						HTTP_PROXY: "",
						HTTPS_PROXY: "",
						ALL_PROXY: "",
					},
					headers: {
						authorization: "forbidden",
						host: "forbidden",
						"x-amz-date": "forbidden",
						"x-custom": "forwarded",
					},
					onResponse(info) {
						replies.push(info);
						if (mode === "callback failure") throw new Error("response callback failed");
					},
				},
			).result();
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				path: "/model/sample-model/converse-stream",
				headers: { "x-custom": "forwarded" },
			});
			expect(requests[0]!.headers.authorization).not.toBe("forbidden");
			expect(requests[0]!.headers.host).toContain("127.0.0.1:");
			expect(requests[0]!.headers["x-amz-date"]).not.toBe("forbidden");
			expect(JSON.parse(requests[0]!.body).messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
			expect(replies).toHaveLength(1);
			expect(replies[0]).toMatchObject({
				status: 200,
				headers: { "x-amzn-requestid": "offline-request", "x-custom-response": "received" },
			});
			if (mode === "callback failure")
				expect(result).toMatchObject({ stopReason: "error", errorMessage: "response callback failed" });
			else
				expect(result).toMatchObject({
					stopReason: "stop",
					content: [{ type: "text", text: "ready" }],
					usage: { input: 2, output: 3, totalTokens: 5 },
				});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);
