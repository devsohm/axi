import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, traceIn, withTelemetry } from "@axi/chord/context";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import {
	Harness,
	createRegistry,
	defineDoc,
	defineTool,
	ProviderDoc,
	ToolResultEntry,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
} from "@axi/durable";
import { createModels, Type, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@axi/ai";
import { openNodeSqliteStorage } from "@axi/durable/storage/sqlite/node";
import { Connection, RemoteExecutionEnv, localDaemon } from "@axi/env";
import { CodingTools } from "@axi/durable/tools";
import { createNodePhotonImages } from "@axi/durable/images/node";
import { createCodemodeExtension, CodemodeStoreDoc } from "@axi/durable/codemode";
import { CodemodeSandbox } from "@axi/codemode";
import { McpClient, LATEST_PROTOCOL_VERSION } from "@axi/mcp";
import { createInMemoryTransportPair } from "@axi/mcp/testing";

const telemetry = new InMemoryTelemetryContext();
const receiver = new InMemoryTelemetryContext();
await traceIn(withTelemetry(telemetry, context), { name: "installed" }, async (child) => {
	telemetry.counter("requests").add(1, { mode: "installed" }, child.telemetry);
	const carrier = telemetry.inject(child.telemetry);
	assert.ok(carrier);
	await receiver.extract(JSON.parse(JSON.stringify(carrier))).startSpan({ name: "received" }, () => 42);
});
assert.deepEqual(
	telemetry.getSpans().map((span) => [span.name, span.settled]),
	[["installed", true]],
);
assert.deepEqual(
	receiver.getSpans().map((span) => span.name),
	["received"],
);
assert.deepEqual(receiver.getSpans()[0].parentContext, telemetry.getSpans()[0].context);
assert.deepEqual(
	telemetry.getMetrics().map((measurement) => [measurement.name, measurement.value]),
	[["requests", 1]],
);

assert.equal(DEFAULT_RESTART_LIMIT, 5);
assert.equal(DEFAULT_RETRY_POLICY.maxRetries, 3);
assert.equal(DEFAULT_COMPACTION_POLICY.reserveTokens, 16384);
assert.equal(DEFAULT_PROGRESS_POLICY.partialIntervalMs, 100);
assert.equal("classifierJson" in (await import("@axi/ai/api/classifier-shared")), false);
assert.equal("openRouterModelSchema" in (await import("@axi/ai/providers/openrouter-api")), false);
assert.equal("isOpenRouterModel" in (await import("@axi/ai/providers/openrouter-api")), false);
for (const subpath of ["api/anthropic-request", "api/bedrock-client", "providers/builtin"])
	assert.throws(() => import.meta.resolve(`@axi/ai/${subpath}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const cwd = await mkdtemp(join(tmpdir(), "axi-public-"));
const envConnection = new Connection({ command: [localDaemon()] });
const Counter = defineDoc({ kind: "counter", scope: "session", version: 1, initial: () => ({ count: 0 }) });
const models = createModels(),
	faux = fauxProvider(),
	registry = createRegistry(),
	reports = [],
	events = [];
models.setProvider(faux.provider);
const sandbox = new CodemodeSandbox();
const pair = createInMemoryTransportPair(),
	client = new McpClient({ name: "installed", version: "1" });
let harness, subscription;
const openHarness = async () =>
	Harness.open(
		await openNodeSqliteStorage(join(cwd, "session.sqlite")),
		{
			models,
			registry,
			env: () => new RemoteExecutionEnv({ connection: envConnection, id: "installed:remote", cwd }),
			onReport: (error) => reports.push(error),
		},
		context,
	);
try {
	pair.server.onMessage(async (message) => {
		if (!("id" in message)) return;
		let result;
		if (message.method === "initialize")
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "local", version: "1" },
			};
		else if (message.method === "tools/list")
			result = {
				tools: [
					{
						name: "increment",
						inputSchema: { type: "object", properties: { by: { type: "number" } }, required: ["by"] },
					},
				],
			};
		else if (message.method === "tools/call") {
			const count = await harness.commit(async (tx) => {
				const state = await tx.doc(Counter);
				state.count += message.params.arguments.by;
				return state.count;
			}, context);
			result = { content: [], structuredContent: { count } };
		} else throw new Error("Unexpected method " + message.method);
		await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	await client.connect(pair.client);
	assert.equal((await client.listTools())[0].name, "increment");
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({ sandbox, models: false }));
	registry.install({
		name: "bridge",
		tools: [
			defineTool({
				name: "increment",
				description: "Increment the persisted counter through MCP",
				parameters: Type.Object({ by: Type.Number() }),
				structuredOutputSchema: Type.Object({ count: Type.Number() }),
				execute: async (args) => ({ structuredOutput: (await client.callTool("increment", args)).structuredContent }),
			}),
		],
	});
	harness = await openHarness();
	let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const identity = (await harness.snapshot(ProviderDoc, root.id, context)).sessionId;
	const view = await root.watch(context);
	view.start((value) => events.push(value.entries.length));
	subscription = () => view.stop();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"codemode",
					{
						code: 'const a=await tools.increment({by:1}); const b=await tools.increment({by:2}); await tools.write({path:"saved.txt",content:String(b.count)}); text([a.count,b.count,await tools.read({path:"saved.txt"})]);store("finished",true);',
					},
					{ id: "script" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	assert.equal((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status, "done");
	assert.equal((await harness.snapshot(Counter, context)).count, 3);
	assert.equal(await readFile(join(cwd, "saved.txt"), "utf8"), "3");
	assert.equal((await harness.snapshot(CodemodeStoreDoc, root.id, context)).values.finished, true);
	const page = await root.entries({}, 1000, undefined, context);
	const result = page.items.find(ToolResultEntry.is);
	assert.equal(result.model[0].isError, false);
	assert.ok(result.model[0].content.some((item) => item.type === "text" && item.text === '[1,3,"3"]'));
	assert.equal(result.model[0].details.calls.length, 4);
	await subscription();
	subscription = undefined;
	await harness.close(context);
	harness = await openHarness();
	root = await harness.root(context);
	assert.equal((await harness.snapshot(Counter, context)).count, 3);
	assert.equal((await harness.snapshot(ProviderDoc, root.id, context)).sessionId, identity);
	assert.equal((await harness.snapshot(CodemodeStoreDoc, root.id, context)).values.finished, true);
	assert.deepEqual(reports, []);
	const images = await createNodePhotonImages({ idleMs: 10 });
	const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	assert.deepEqual(
		await images.prepare(Uint8Array.from(Buffer.from(gif, "base64")), "image/gif", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 100000,
		}),
		{ data: gif, mimeType: "image/gif" },
	);
	console.log(JSON.stringify({ counter: 3, viewUpdates: events.length, installed: true }));
} finally {
	envConnection.close();
	await subscription?.();
	await sandbox.close();
	await client.close();
	await pair.server.close();
	await harness?.close(context);
	await rm(cwd, { recursive: true, force: true });
}
