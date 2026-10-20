import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@axi/chord/context";
import { getOrThrow } from "@axi/durable/env";
import { expect, test } from "vitest";
import { Connection, localDaemon, RemoteExecutionEnv } from "../src/index.ts";

test("remote files preserve chunk order, ranged bytes and lines split across transfer boundaries", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "axi-transfer-"));
	const connection = new Connection({ command: [localDaemon()] });
	const env = new RemoteExecutionEnv({ connection, id: "transfer", cwd });
	try {
		const bytes = Uint8Array.from({ length: 1_310_727 }, (_, index) => index % 251);
		getOrThrow(await env.writeFile("bytes", bytes, context));
		getOrThrow(await env.appendFile("bytes", new Uint8Array([254, 255]), context));
		const complete = getOrThrow(await env.readBinaryFile("bytes", context));
		expect(Buffer.compare(Buffer.from(complete.subarray(0, bytes.length)), Buffer.from(bytes))).toBe(0);
		expect([...complete.subarray(bytes.length)]).toEqual([254, 255]);
		const reader = getOrThrow(await env.openBinaryReader("bytes", undefined, context));
		try {
			expect(
				Buffer.compare(
					Buffer.from(getOrThrow(await reader.read(262139, 524301, context))),
					Buffer.from(bytes.subarray(262139, 786440)),
				),
			).toBe(0);
			expect([...getOrThrow(await reader.read(bytes.length, 999, context))]).toEqual([254, 255]);
			expect(getOrThrow(await reader.read(bytes.length + 2, 10, context)).length).toBe(0);
		} finally {
			await reader.close(context);
		}
		const text = "a".repeat(65535) + "🙂\nsecond\nlast";
		getOrThrow(await env.writeFile("lines", text, context));
		const lines = getOrThrow(await env.openTextLineReader("lines", context));
		try {
			expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "a".repeat(65535) + "🙂", terminated: true });
			expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "second", terminated: true });
			expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "last", terminated: false });
			expect(getOrThrow(await lines.readLine(context))).toBeUndefined();
		} finally {
			await lines.close(context);
		}
		expect(await lines.readLine(context)).toMatchObject({ ok: false, error: { code: "invalid" } });
	} finally {
		await env.cleanup(context);
		connection.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"remote commands bound output while accounting for every emitted byte",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		const env = new RemoteExecutionEnv({ connection, id: "output-window", cwd: tmpdir() });
		let delivered = 0,
			skipped = 0,
			tail = "";
		try {
			const result = getOrThrow(
				await env.exec(
					[process.execPath, "-e", 'process.stdout.write("0123456789\\n".repeat(200000))'],
					{
						window: { maxBytes: 512, maxLines: 10, minIntervalMs: 10, bytesPerSecond: 65536 },
						onOutput(text, _context, info) {
							delivered += Buffer.byteLength(text);
							if (info.skipped) {
								skipped += info.skipped.bytes;
								tail = "";
							}
							tail += text;
						},
					},
					context,
				),
			);
			expect(result.exitCode).toBe(0);
			expect(delivered + skipped).toBe(2200000);
			expect(skipped).toBeGreaterThan(1000000);
			expect(tail.endsWith("0123456789\n")).toBe(true);
			expect("0123456789\n".repeat(200000).endsWith(tail)).toBe(true);
			const timed = await env.exec([process.execPath, "-e", "setTimeout(()=>{},10000)"], { timeout: 0.05 }, context);
			expect(timed).toMatchObject({ ok: false, error: { code: "timeout" } });
			const aborted = await env.exec([process.execPath, "-e", "setTimeout(()=>{},10000)"], undefined, {
				...context,
				abortSignal: AbortSignal.abort(),
			});
			expect(aborted).toMatchObject({ ok: false, error: { code: "aborted" } });
		} finally {
			await env.cleanup(context);
			connection.close();
		}
	},
);
