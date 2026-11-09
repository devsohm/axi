import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@axi/codemode";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { createCodemodeExtension, type CodemodeToolOptions } from "../src/codemode/index.ts";
import {
	createRegistry,
	defineTool,
	Harness,
	MemoryStorage,
	ToolResultEntry,
	type ToolRegistration,
} from "../src/index.ts";

async function fixture(
	tools: readonly ToolRegistration[],
	options: Pick<CodemodeToolOptions, "namespaces" | "globals"> = {},
) {
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });
	registry.install(createCodemodeExtension({ sandbox, models: false, ...options }));
	registry.install({ name: "fixtures", tools });
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	let sequence = 0;
	return {
		async run(code: string) {
			const id = `script-${++sequence}`;
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			expect(
				(await (await conversation.submit({ type: "input", content: "Run the script" }, context)).wait(context)).status,
			).toBe("done");
			const entries = await conversation.entries({}, 100, undefined, context);
			const message = entries.items
				.filter(ToolResultEntry.is)
				.flatMap((entry) => entry.model ?? [])
				.find((item) => item.role === "toolResult" && item.toolCallId === id);
			if (message?.role !== "toolResult") throw new Error("Missing script result");
			expect(message.isError, JSON.stringify(message.content)).toBe(false);
			const body = message.content[1];
			if (body?.type !== "text") throw new Error("Missing script output");
			const value: unknown = JSON.parse(body.text);
			return { value, details: message.details };
		},
		async [Symbol.asyncDispose]() {
			await harness.close(context);
			await sandbox.close();
		},
	};
}
const parameters = Type.Object({});

test("code discovery groups tools by their longest namespace and hides internal model tools", async () => {
	const tools = ["repo.read", "repo.write", "repo.deep.read", "plain"].map((name) =>
		defineTool({ name, description: "Repository operation", parameters, execute: async () => ({ output: [] }) }),
	);
	await using app = await fixture(tools, {
		namespaces: [
			{ name: "Repo-tools", prefix: "repo.", description: "Repository utilities", instructions: "Use relative paths" },
			{ name: "Deep", prefix: "repo.deep." },
		],
	});
	const result = await app.run(
		`return { parent: await describeNamespace("Repo_tools"), deep: await describeNamespace("Deep"), missing: (await describeNamespace("absent")) ?? null, tools: (await searchTools("Repository", { namespace: "Repo-tools", limit: 8 })).map(tool=>tool.name).sort(), plain: (await searchTools("Repository", { namespace: "absent" })).length, description: await describeTool("repo_read") };`,
	);
	expect(result.value).toMatchObject({
		parent: {
			name: "Repo-tools",
			description: "Repository utilities",
			instructions: "Use relative paths",
			tools: ["repo_read", "repo_write"],
		},
		deep: { name: "Deep", tools: ["repo_deep_read"] },
		missing: null,
		tools: ["repo_read", "repo_write"],
		plain: 0,
		description: expect.stringContaining("Repository operation"),
	});
});

test("discovery validates names and options while a later valid call remains usable", async () => {
	await using app = await fixture([]);
	for (const [expression, message] of [
		["describeTool(1)", "expects a tool name"],
		["describeNamespace(null)", "expects a namespace name"],
		["searchTools(null)", "expects a query string"],
		["searchTools('x', {limit: 0})", "limit must be a positive integer"],
		["searchTools('x', {limit: -1})", "limit must be a positive integer"],
		["searchTools('x', {limit: 1.5})", "limit must be a positive integer"],
		["searchTools('x', {limit: '2'})", "limit must be a positive integer"],
		["searchTools('x', {namespace: 2})", "namespace must be a string"],
	]) {
		const result = await app.run(
			`try { await ${expression}; return "no error"; } catch(error) { return {message: error.message, later: (await describeTool("absent")) ?? null}; }`,
		);
		expect(result.value).toEqual({ message: expect.stringContaining(message), later: null });
	}
});

test("ordinary nested calls expose text content while structured errors remain inspectable values", async () => {
	const ordinary = defineTool({
		name: "ordinary",
		description: "Text result",
		parameters,
		execute: async () => ({
			output: [
				{ type: "text" as const, text: "first" },
				{ type: "image" as const, data: "AA==", mimeType: "image/png" },
				{ type: "text" as const, text: "second" },
			],
		}),
	});
	const structured = defineTool({
		name: "structured",
		description: "Structured result",
		parameters,
		structuredOutputSchema: Type.Object({ count: Type.Number() }),
		execute: async () => ({
			isError: true,
			structuredOutput: { count: 7 },
			diagnostics: [
				{ severity: "warn" as const, code: "hint", message: "not an error" },
				{ severity: "error" as const, code: "first", message: "first error" },
				{ severity: "error" as const, code: "second", message: "second error" },
			],
		}),
	});
	await using app = await fixture([ordinary, structured]);
	const result = await app.run("return { text: await tools.ordinary(), object: await tools.structured() };");
	expect(result.value).toEqual({ text: "first\nsecond", object: { count: 7 } });
	expect(result.details).toMatchObject({
		calls: [
			{ name: "ordinary", status: "ok" },
			{ name: "structured", status: "error", error: "first error\nsecond error" },
		],
	});
});

test("nested failures prefer text output, then error diagnostics, then an actionable fallback", async () => {
	const tools = [
		defineTool({
			name: "with_text",
			description: "Text failure",
			parameters,
			execute: async () => ({
				isError: true,
				output: [{ type: "text" as const, text: "visible failure" }],
				diagnostics: [{ severity: "error" as const, code: "detail", message: "diagnostic failure" }],
			}),
		}),
		defineTool({
			name: "with_diagnostic",
			description: "Diagnostic failure",
			parameters,
			execute: async () => ({
				isError: true,
				diagnostics: [
					{ severity: "warn" as const, code: "hint", message: "warning" },
					{ severity: "error" as const, code: "detail", message: "diagnostic failure" },
				],
			}),
		}),
		defineTool({
			name: "without_detail",
			description: "Empty failure",
			parameters,
			execute: async () => ({ isError: true }),
		}),
	];
	await using app = await fixture(tools);
	const result = await app.run(
		'const errors=[]; for(const name of ["with_text","with_diagnostic","without_detail"]) { try { await tools[name](); } catch(error) { errors.push(error.message); } } return errors;',
	);
	expect(result.value).toEqual(["visible failure", "diagnostic failure", "Tool without_detail failed"]);
	expect(result.details).toMatchObject({ calls: tools.map((tool) => ({ name: tool.name, status: "error" })) });
});

test("custom globals receive ordinary and spread arguments and failed globals do not create tool cards", async () => {
	const received: unknown[] = [];
	await using app = await fixture([], {
		globals: [
			{
				name: "host.echo",
				async execute(args) {
					received.push(args);
					return "ordinary";
				},
			},
			{
				name: "host.spread",
				spread: true,
				async execute(args) {
					received.push(args);
					return "spread";
				},
			},
			{
				name: "host.fail",
				async execute() {
					throw new Error("Global unavailable");
				},
			},
		],
	});
	const result = await app.run(
		'let failure; try { await host.fail(); } catch(error) { failure=error.message; } return { ordinary: await host.echo({n:7}), spread: await host.spread(1,"two",null), failure };',
	);
	expect(result.value).toEqual({ ordinary: "ordinary", spread: "spread", failure: "Global unavailable" });
	expect(received).toEqual([{ n: 7 }, [1, "two", null]]);
	expect(result.details).toEqual({ calls: [] });
});
