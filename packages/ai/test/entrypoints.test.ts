import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { bedrockConverseStreamApi } from "../src/api/bedrock-converse-stream.lazy.ts";
import { bedrockProviderModule } from "../src/bedrock-provider.ts";
import { registerLazyBedrockProvider } from "../src/lazy-bedrock-provider.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

test("direct and bundled lazy Bedrock entrypoints reach the real encoder without sending a request", async () => {
	registerLazyBedrockProvider();
	const model: Model<"bedrock-converse-stream"> = {
		api: "bedrock-converse-stream",
		provider: "test-bedrock",
		id: "model",
		name: "Model",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		contextWindow: 8000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
	const seen: unknown[] = [];
	const options = {
		apiKey: "offline-test-token",
		onPayload(payload: unknown) {
			seen.push(payload);
			throw new Error("stopped before network dispatch");
		},
	};
	const lazy = bedrockConverseStreamApi();
	for (const stream of [
		bedrockProviderModule.stream(model, context, options),
		bedrockProviderModule.streamSimple(model, context, options),
		lazy.stream(model, context, options),
		lazy.streamSimple(model, context, options),
	])
		expect(await stream.result()).toMatchObject({
			stopReason: "error",
			errorMessage: "stopped before network dispatch",
		});
	expect(seen).toHaveLength(4);
	for (const payload of seen)
		expect(payload).toMatchObject({ modelId: model.id, messages: [{ role: "user", content: [{ text: "hello" }] }] });
});

test("the executable lists providers and documents commands without creating credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-ai-cli-"));
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	try {
		for (const args of [[], ["--help"], ["help"], ["-h"], ["list"]]) {
			const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8", timeout: 10_000 });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("openai-codex");
			if (args[0] !== "list") expect(result.stdout).toContain("Usage: axi-ai");
		}
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);

test("invalid commands, providers and interactive choices fail without starting authentication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-ai-cli-invalid-"));
	const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	try {
		for (const [args, input, diagnostic] of [
			[["unknown"], "", "Unknown command"],
			[["login", "not-a-provider"], "", "Unknown provider"],
			[["login"], "0\n", "Unknown provider"],
		] satisfies [string[], string, string][]) {
			const result = spawnSync(process.execPath, [cli, ...args], {
				cwd: directory,
				input,
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(result.status, result.stderr).toBe(1);
			expect(result.stderr).toContain(diagnostic);
		}
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);
