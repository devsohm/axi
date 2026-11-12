import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createNodePhotonImages } from "../src/images/node.ts";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "../src/index.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createEditTool } from "../src/tools/edit.ts";

async function fixture(read = createReadTool()) {
	const cwd = await mkdtemp(join(tmpdir(), "axi-file-tools-"));
	const env = new NodeExecutionEnv({ cwd }),
		models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const results = new Map<string, Awaited<ReturnType<typeof read.execute>>>();
	const recordedRead: typeof read = {
		...read,
		execute: async (args, api, ctx) => {
			const result = await read.execute(args, api, ctx);
			results.set(api.callId, result);
			return result;
		},
	};
	registry.install({ name: "files", tools: [recordedRead, createEditTool()] });
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
	const root = await harness.root(context, { agent: { model: { provider: provider.provider.id, modelId: "faux-1" } } });
	let next = 0;
	return {
		cwd,
		async invoke(name: string, args: Parameters<typeof fauxToolCall>[1]) {
			const id = `file-${++next}`;
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await (await root.submit({ type: "input", content: "Run file operation" }, context)).wait(context);
			await harness.waitForIdle(context);
			const entries = await storage.scanEntries({ conversationId: root.id }, 100, undefined, context);
			for (const entry of entries.items.filter(ToolResultEntry.is)) {
				const message = entry.model?.find((message) => message.role === "toolResult" && message.toolCallId === id);
				if (message?.role === "toolResult")
					return { message, diagnostics: entry.data?.diagnostics, structuredOutput: results.get(id)?.structuredOutput };
			}
			throw new Error(`Missing result for ${id}`);
		},
		async [Symbol.asyncDispose]() {
			await harness.close(context);
			await env.cleanup(context);
			await rm(cwd, { force: true, recursive: true });
		},
	};
}

test("read selects complete UTF-8 lines, strips the initial BOM and reports continuation", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "notes"), "\ufefffirst\n界🙂\nlast\n");
	const first = await files.invoke("read", { path: "notes", limit: 1 });
	expect(first.structuredOutput).toBe("first");
	expect(first.message).toMatchObject({
		isError: false,
		content: [
			{ type: "text", text: "first" },
			{ type: "text", text: expect.stringContaining("Use offset=2") },
		],
	});
	const later = await files.invoke("read", { path: "notes", offset: 2, limit: 1 });
	expect(later.structuredOutput).toBe("界🙂");
	expect(later.message.content[0]).toEqual({ type: "text", text: "界🙂" });
	expect(later.diagnostics).toEqual([{ severity: "info", message: "2 more lines in file. Use offset=3 to continue." }]);
	const empty = await files.invoke("read", { path: "notes", limit: 0 });
	expect(empty.structuredOutput).toBe("");
	expect(empty.message).toMatchObject({ isError: false });
	expect(empty.diagnostics).toEqual([{ severity: "info", message: "4 more lines in file. Use offset=1 to continue." }]);
});

test("read returns an image block to callers as well as the model", async () => {
	await using files = await fixture();
	await writeFile(
		join(files.cwd, "pixel.png"),
		Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"),
	);
	const result = await files.invoke("read", { path: "pixel.png" });
	expect(result.message.isError).toBe(false);
	expect(result.structuredOutput).toMatchObject({ type: "image", mimeType: "image/png", data: expect.any(String) });
	expect(result.message.content).toContainEqual(result.structuredOutput);
});

test("read rejects images with unavailable dimensions or excessive size", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "short.gif"), "GIF89a");
	const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000fa0000000020806000000", "hex");
	await writeFile(join(files.cwd, "wide.png"), png);
	await writeFile(join(files.cwd, "large.gif"), new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]));
	await truncate(join(files.cwd, "large.gif"), 4 * 1024 * 1024);
	for (const [path, message] of [
		["short.gif", "whose size cannot be read"],
		["wide.png", "larger than 2000x2000"],
		["large.gif", "too large to send"],
	]) {
		const result = await files.invoke("read", { path });
		expect(result.message.isError).toBe(true);
		expect(result.message.content.some((block) => block.type === "image")).toBe(false);
		expect(result.diagnostics).toEqual([
			{ severity: "error", code: "unsupported_image", message: expect.stringContaining(message) },
		]);
	}
});

function bitmap(): Uint8Array {
	const bytes = new Uint8Array(58);
	const view = new DataView(bytes.buffer);
	bytes.set([66, 77]);
	for (const [offset, value] of [[2, 58], [10, 54], [14, 40], [18, 1], [22, 1], [34, 4]])
		view.setUint32(offset, value, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	bytes.set([120, 80, 40], 54);
	return bytes;
}

test("read converts bitmap files with the configured image worker", async () => {
	await createNodePhotonImages({ worker: false });
	const bytes = bitmap();
	await using plain = await fixture();
	await writeFile(join(plain.cwd, "pixel.bmp"), bytes);
	const refused = await plain.invoke("read", { path: "pixel.bmp" });
	expect(refused.message.isError).toBe(true);
	expect(refused.diagnostics).toEqual([
		{ severity: "error", code: "unsupported_image", message: expect.stringContaining("needs converting") },
	]);
	const images = await createNodePhotonImages({ idleMs: 0 });
	await using prepared = await fixture(createReadTool({ images }));
	await writeFile(join(prepared.cwd, "pixel.bmp"), bytes);
	const result = await prepared.invoke("read", { path: "pixel.bmp" });
	expect(result.message.isError).toBe(false);
	expect(result.diagnostics).toEqual([
		{ severity: "info", code: "image", message: "Read image file [image/png]. Converted from image/bmp to image/png." },
	]);
	const image = result.message.content.find((block) => block.type === "image");
	if (image?.type !== "image") throw new Error("The converted image is missing");
	const decoded = PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
	try {
		expect([decoded.get_width(), decoded.get_height()]).toEqual([1, 1]);
		expect([...decoded.get_raw_pixels()]).toEqual([40, 80, 120, 255]);
	} finally {
		decoded.free();
	}
});

test("read resizes a valid oversized image and reports its coordinate scale", async () => {
	await createNodePhotonImages({ worker: false });
	const images = await createNodePhotonImages({ idleMs: 0 });
	await using files = await fixture(createReadTool({ images }));
	const source = new PhotonImage(new Uint8Array(4000 * 2 * 4).fill(255), 4000, 2);
	try {
		await writeFile(join(files.cwd, "wide.png"), source.get_bytes());
	} finally {
		source.free();
	}
	const result = await files.invoke("read", { path: "wide.png" });
	expect(result.message.isError).toBe(false);
	expect(result.diagnostics).toEqual([
		{
			severity: "info",
			code: "image",
			message: "Read image file [image/png]. Resized from 4000x2 to 2000x1. Multiply coordinates by 2.00 to map them to the original.",
		},
	]);
	const image = result.message.content.find((block) => block.type === "image");
	if (image?.type !== "image") throw new Error("The resized image is missing");
	const decoded = PhotonImage.new_from_byteslice(Buffer.from(image.data, "base64"));
	try {
		expect([decoded.get_width(), decoded.get_height()]).toEqual([2000, 1]);
	} finally {
		decoded.free();
	}
});

test("read reports an image decoder refusal without ending the conversation", async () => {
	const images = await createNodePhotonImages({ idleMs: 0 });
	await using files = await fixture(createReadTool({ images }));
	await writeFile(join(files.cwd, "broken.gif"), "GIF89a");
	const result = await files.invoke("read", { path: "broken.gif" });
	expect(result.message.isError).toBe(true);
	expect(result.diagnostics).toEqual([
		{ severity: "error", code: "unsupported_image", message: expect.stringContaining("cannot be prepared") },
	]);
	await writeFile(join(files.cwd, "note"), "Still available");
	expect((await files.invoke("read", { path: "note" })).structuredOutput).toBe("Still available");
});

test("read reports the remaining lines consistently for fractional selections", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "notes"), "a\nb\nc");
	const result = await files.invoke("read", { path: "notes", offset: 1.01, limit: 0.3 });
	expect(result.structuredOutput).toBe("");
	expect(result.diagnostics).toEqual([
		{ severity: "info", message: "2.69 more lines in file. Use offset=1.31 to continue." },
	]);
});

test("read keeps its initial line selection while the environment opens the file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-read-selection-"));
	const env = new NodeExecutionEnv({ cwd });
	const models = createModels(),
		provider = fauxProvider(),
		registry = createRegistry();
	models.setProvider(provider.provider);
	const read = createReadTool();
	const selectedRead: typeof read = {
		...read,
		async execute(args, api, context) {
			const open = env.openBinaryReader.bind(env);
			env.openBinaryReader = async (...input) => {
				args.path = "changed";
				args.offset = 2;
				args.limit = 2;
				return open(...input);
			};
			try {
				return await read.execute(args, api, context);
			} finally {
				env.openBinaryReader = open;
			}
		},
	};
	registry.install({ name: "files", tools: [selectedRead] });
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
	try {
		await writeFile(join(cwd, "notes"), "first\nsecond\nthird");
		provider.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "notes", offset: 1, limit: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			(await (await root.submit({ type: "input", content: "Read the first line" }, context)).wait(context)).status,
		).toBe("done");
		await harness.waitForIdle(context);
		const result = (await storage.scanEntries({ conversationId: root.id }, 100, undefined, context)).items.find(
			ToolResultEntry.is,
		);
		expect(result?.model?.[0]).toMatchObject({
			role: "toolResult",
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "<harness>\n[info] 2 more lines in file. Use offset=2 to continue.\n</harness>" },
			],
		});
	} finally {
		await harness.close(context);
		await env.cleanup(context);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("read limits oversized lines at a UTF-8 boundary and returns a warning", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "wide"), "🙂".repeat(13000));
	const result = await files.invoke("read", { path: "wide" });
	expect(result.message).toMatchObject({
		isError: false,
		details: { truncation: { truncated: true, firstLineExceedsLimit: true, outputBytes: 51200, outputLines: 1 } },
	});
	expect(result.message.content[0]).toEqual({ type: "text", text: "🙂".repeat(12800) });
	expect(result.diagnostics).toEqual([
		{
			severity: "warn",
			code: "truncated",
			message:
				"Line 1 is 50.8KB, exceeds the 50.0KB limit; showing its first 50.0KB. Use bash: sed -n '1p' wide | tail -c +51201",
		},
	]);
});

test("read limits long files by lines and rejects offsets past EOF without poisoning later requests", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "long"), Array.from({ length: 2005 }, (_, i) => `row${i + 1}`).join("\n"));
	const result = await files.invoke("read", { path: "long" });
	expect(result.message).toMatchObject({
		isError: false,
		details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000 } },
	});
	const text = result.message.content[0];
	if (text?.type !== "text") throw new Error("No text returned");
	expect(text.text.split("\n").at(-1)).toBe("row2000");
	expect(result.diagnostics).toEqual([
		{ severity: "info", code: "truncated", message: "Showing lines 1-2000 of 2005. Use offset=2001 to continue." },
	]);
	const invalid = await files.invoke("read", { path: "long", offset: 2006 });
	expect(invalid.message.isError).toBe(true);
	expect(invalid.diagnostics).toEqual([
		{ severity: "error", code: "tool_error", message: "Offset 2006 is beyond end of file (2005 lines total)" },
	]);
	const tail = await files.invoke("read", { path: "long", offset: 2005 });
	expect(tail.message).toMatchObject({ isError: false, content: [{ type: "text", text: "row2005" }] });
});

test("edit preserves CRLF and BOM, accepts normalized argument forms and persists its diff", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "notes"), "\ufeffalpha\r\nbeta\r\n");
	const edited = await files.invoke("edit", {
		path: "notes",
		edits: JSON.stringify({ oldText: "beta", newText: "BETA\nend" }),
	});
	expect(edited.message).toMatchObject({
		isError: false,
		content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes." }],
		details: { firstChangedLine: 2, diff: " 1 alpha\n-2 beta\n+2 BETA\n+3 end" },
	});
	expect(await readFile(join(files.cwd, "notes"), "utf8")).toBe("\ufeffalpha\r\nBETA\r\nend\r\n");
	const next = await files.invoke("edit", { path: "notes", oldText: "end", newText: "done" });
	expect(next.message.isError).toBe(false);
	expect(await readFile(join(files.cwd, "notes"), "utf8")).toBe("\ufeffalpha\r\nBETA\r\ndone\r\n");
});

test("failed edits leave the file untouched and a later valid edit still succeeds", async () => {
	await using files = await fixture();
	await writeFile(join(files.cwd, "notes"), "same same\nunique\n");
	for (const args of [
		{ edits: [] },
		{ edits: [{ oldText: "same", newText: "x" }] },
		{ edits: [{ oldText: "missing", newText: "x" }] },
	]) {
		const result = await files.invoke("edit", { path: "notes", ...args });
		expect(result.message.isError).toBe(true);
		expect(await readFile(join(files.cwd, "notes"), "utf8")).toBe("same same\nunique\n");
	}
	const result = await files.invoke("edit", { path: "notes", edits: { oldText: "unique", newText: "updated" } });
	expect(result.message.isError).toBe(false);
	expect(await readFile(join(files.cwd, "notes"), "utf8")).toBe("same same\nupdated\n");
});
