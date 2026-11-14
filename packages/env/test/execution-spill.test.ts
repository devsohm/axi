import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test.each(["success", "nonzero", "abort", "timeout"] as const)(
	"remote execution retains complete spill output after %s",
	async (outcome) => {
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "spill-output", cwd: tmpdir() });
		const controller = new AbortController(),
			output: string[] = [];
		const text = "first line\nsecond line\n";
		let spillPath: string | undefined;
		try {
			const program = `process.stdout.write(${JSON.stringify(text)}, () => {
				${outcome === "success" || outcome === "nonzero" ? `process.exitCode = ${outcome === "success" ? 0 : 7}` : "setInterval(() => {}, 10000)"};
			})`;
			const result = await env.exec(
				[process.execPath, "-e", program],
				{
					spill: { afterBytes: 0, afterLines: 0 },
					...(outcome === "timeout" ? { timeout: 3 } : {}),
					onOutput(text) {
						output.push(text);
						if (outcome === "abort") controller.abort();
					},
				},
				{ ...context, abortSignal: controller.signal },
			);
			spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
			if (spillPath === undefined) throw new Error("Missing complete output file");
			expect(await readFile(spillPath, "utf8")).toBe(text);
			expect(output.join("")).toBe(text);
			if (outcome === "success" || outcome === "nonzero") {
				expect(result).toEqual({ ok: true, value: { exitCode: outcome === "success" ? 0 : 7, spillPath } });
			} else {
				expect(result).toMatchObject({
					ok: false,
					error: { code: outcome === "abort" ? "aborted" : "timeout", spillPath },
				});
			}
			expect(getOrThrow(await env.exec([process.execPath, "-e", ""], undefined, context)).exitCode).toBe(0);
		} finally {
			await env.cleanup(context);
			connection.close();
			if (spillPath !== undefined) await rm(dirname(spillPath), { recursive: true, force: true });
		}
	},
);
