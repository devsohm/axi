import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@axi/ai";
import { Harness, createRegistry, ToolResultEntry } from "@axi/durable";
import { getOrThrow } from "@axi/durable/env";
import { MemoryStorage } from "@axi/durable/storage/memory";
import { CodingTools } from "@axi/durable/tools";
import { registerEnvConformance } from "@axi/durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
	Connection,
	LocalExecutionEnv,
	localDaemon,
	openTerminal,
	RemoteExecutionEnv,
	type RemoteExecutionEnvOptions,
} from "../src/index.ts";

const connection = new Connection({ command: [process.env.AXI_ENV_DAEMON ?? localDaemon()] });
afterAll(() => connection.close());
it("checks command cancellation before reading execution settings", async () => {
	let reads = 0;
	const env = new RemoteExecutionEnv({ connection, id: "cancelled-command", cwd: tmpdir() });
	const result = await env.exec(
		"unused",
		{
			get timeout(): number {
				reads++;
				throw new Error("cancelled execution read its settings");
			},
		},
		{ ...context, abortSignal: AbortSignal.abort() },
	);
	expect(result.ok ? undefined : result.error.code).toBe("aborted");
	expect(reads).toBe(0);
});
it("resolves reader paths before evaluating open options and skips options after cancellation", async () => {
	const env = new RemoteExecutionEnv({ connection, id: "reader-options", cwd: tmpdir() });
	let reads = 0;
	const options = {
		get noFollow(): boolean {
			reads++;
			throw new Error("open options failed");
		},
	};
	const cancelled = await env.openBinaryReader("file", options, { ...context, abortSignal: AbortSignal.abort() });
	expect(cancelled.ok ? undefined : cancelled.error.code).toBe("aborted");
	expect(reads).toBe(0);
	const failed = await env.openBinaryReader("file", options, context);
	expect(failed.ok ? undefined : failed.error.message).toBe("open options failed");
	expect(reads).toBe(1);
});
it("keeps constructor settings and captures inheritance before resolving a command directory", async () => {
	const settings: RemoteExecutionEnvOptions = {
		connection,
		id: "command-settings",
		cwd: tmpdir(),
		shellEnv: { AXI_ENV_SETTING: "initial" },
	};
	const env = new RemoteExecutionEnv(settings);
	settings.shellPath = "/missing-shell";
	settings.shellEnv = { AXI_ENV_SETTING: "changed" };
	let output = "";
	const onOutput = (text: string) => {
		output += text;
	};
	getOrThrow(await env.exec('printf "%s" "$AXI_ENV_SETTING"', { onOutput }, context));
	expect(output).toBe("initial");
	output = "";
	let inheritEnv = true;
	getOrThrow(
		await env.exec(
			'printf "%s" "$AXI_ENV_SETTING"',
			{
				get cwd() {
					inheritEnv = false;
					return tmpdir();
				},
				get inheritEnv() {
					return inheritEnv;
				},
				onOutput,
			},
			context,
		),
	);
	expect(output).toBe("initial");
});
it("reads line ranges declared as inherited getters", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-line-range-"));
	class Range {
		get startLine() {
			return 1;
		}
		get endLine() {
			return 2;
		}
	}
	try {
		await writeFile(join(cwd, "lines.txt"), "one\ntwo\nthree");
		const env = new RemoteExecutionEnv({ connection, id: "line-range", cwd });
		const reader = getOrThrow(await env.openBinaryReader("lines.txt", undefined, context));
		try {
			expect(getOrThrow(await reader.scanLines(new Range(), context))).toEqual({
				newlines: 2,
				start: 4,
				end: 7,
				firstLineEnd: 7,
				lastLineStart: 4,
				selectedBytes: 3,
				firstLineBytes: 3,
			});
		} finally {
			await reader.close(context);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
it("lists the resolved directory with inherited options and ignores unrelated option fields", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-listing-"));
	class ListingOptions {
		path = join(cwd, "missing");
		get hidden() {
			return false;
		}
	}
	try {
		await writeFile(join(cwd, "visible.txt"), "visible");
		await writeFile(join(cwd, ".hidden.txt"), "hidden");
		const env = new RemoteExecutionEnv({ connection, id: "listing-options", cwd });
		expect(getOrThrow(await env.listFiles(".", new ListingOptions(), context))).toEqual({
			entries: [{ path: "visible.txt", kind: "file" }],
			truncated: false,
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
for (const remote of [false, true]) {
	registerEnvConformance(
		{ describe, expect, it },
		remote ? "remote environment" : "local environment",
		async (use) => {
			const cwd = await mkdtemp(join(tmpdir(), "axi-environment-"));
			const env = remote
				? new RemoteExecutionEnv({ connection, id: "remote:test", cwd, watch: { pollIntervalMs: 50 } })
				: new LocalExecutionEnv({ connection, cwd, watch: { pollIntervalMs: 50 } });
			try {
				await use(env);
			} finally {
				await env.cleanup(context);
				await rm(cwd, { recursive: true, force: true });
			}
		},
		{
			listFiles: true,
			...(process.platform === "win32"
				? {
						shell: [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "-c"],
						symlinks: false,
					}
				: {}),
		},
	);
}
it("runs durable tools through a remote filesystem and shell", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-remote-harness-")),
		models = createModels(),
		scripted = fauxProvider(),
		registry = createRegistry();
	models.setProvider(scripted.provider);
	registry.install(CodingTools);
	const env = new RemoteExecutionEnv({ connection, id: "remote:integration", cwd });
	const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, context);
	try {
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "message.txt", content: "hello\n" }, { id: "write" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat message.txt" }, { id: "shell" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "message.txt" }, { id: "read" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("finished")]),
		]);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		expect(
			(
				await (
					await root.submit(
						{ type: "input", content: "Save the message, run it through the shell, and read it." },
						context,
					)
				).wait(context)
			).status,
		).toBe("done");
		expect(getOrThrow(await env.readTextFile("message.txt", context))).toBe("hello\n");
		const entries = (await root.entries({}, 100, undefined, context)).items.filter(ToolResultEntry.is);
		const messages = entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
		expect(messages.map((message) => message.isError)).toEqual([false, false, false]);
		for (const name of ["bash", "read"]) {
			const result = messages.find((message) => message.toolName === name);
			expect(
				result?.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join(""),
			).toBe("hello\n");
		}
	} finally {
		await harness.close(context);
		await env.cleanup(context);
		await rm(cwd, { recursive: true, force: true });
	}
});
it.skipIf(process.platform === "win32")("starts a terminal with its requested size and streams its bytes", async () => {
	const output: Uint8Array[] = [];
	const terminal = await openTerminal(connection, {
		cwd: tmpdir(),
		cols: 91,
		rows: 27,
		argv: ["sh", "-c", "stty size; printf finished"],
		onData: (bytes) => output.push(bytes),
	});
	expect(await terminal.exited).toBe(0);
	expect(Buffer.concat(output).toString()).toBe("27 91\r\nfinished");
});
