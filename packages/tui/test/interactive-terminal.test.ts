import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Terminal as Emulator } from "@xterm/headless";
import { Connection, localDaemon, openTerminal, type RemoteTerminal } from "@axi/env";
import { expect, test, vi } from "vitest";

test.skipIf(process.platform === "win32").each(["regular", "fullscreen"])(
	"the %s UI handles editing, overlays, large output, streaming, resizing and Ctrl+C in a real PTY",
	async (mode) => {
		const directory = await mkdtemp(join(tmpdir(), "axi-interactive-"));
		const report = join(directory, "events.jsonl");
		const connection = new Connection({ command: [localDaemon()] });
		const emulator = new Emulator({ cols: 50, rows: 12, allowProposedApi: true, scrollback: 5000 });
		let terminal: RemoteTerminal | undefined;
		const output: Uint8Array[] = [];
		const replies = emulator.onData((data) => terminal?.write(data));
		async function events() {
			const text = await readFile(report, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return "";
			});
			return text
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		}
		async function screen() {
			await new Promise<void>((resolve) => emulator.write("", resolve));
			const buffer = emulator.buffer.active;
			return Array.from(
				{ length: emulator.rows },
				(_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
			).join("\n");
		}
		try {
			terminal = await openTerminal(connection, {
				cwd: directory,
				cols: 50,
				rows: 12,
				argv: [
					process.execPath,
					fileURLToPath(new URL("./fixtures/interactive-terminal.mjs", import.meta.url)),
					mode,
					report,
				],
				onData(bytes) {
					output.push(bytes);
					emulator.write(bytes);
				},
			});
			// Slower CI hosts need a separate allowance for loading the child process.
			await vi.waitFor(
				async () => {
					expect(
						(await events()).some((event) => event.event === "ready"),
						`UI startup output:\n${Buffer.concat(output).toString("utf8")}`,
					).toBe(true);
				},
				{ timeout: 10000 },
			);
			terminal.write("draft\x1b[200~ 日本語\nsecond line\x1b[201~\r");
			await vi.waitFor(async () =>
				expect((await events()).find((event) => event.event === "submitted")).toEqual({
					event: "submitted",
					text: "draft 日本語\nsecond line",
				}),
			);
			terminal.write("\x1b[111;5u\x1b[111;5:3u");
			await vi.waitFor(async () => expect(await screen()).toContain("Overlay is open"));
			terminal.write("\x1b[111;5u\x1b[111;5:3u");
			await vi.waitFor(async () => expect(await screen()).not.toContain("Overlay is open"));
			terminal.write("\x1b[116;5u\x1b[116;5:3u");
			await vi.waitFor(async () => expect(await screen()).toContain("tool row 1999"));
			const visibleRows = (await screen()).split("\n").flatMap((line) => {
				const match = /^tool row (\d+)$/.exec(line);
				return match ? [Number(match[1])] : [];
			});
			expect(visibleRows).toEqual(
				Array.from({ length: visibleRows.length }, (_, index) => 2000 - visibleRows.length + index),
			);
			terminal.write("\x1b[116;5u\x1b[116;5:3u");
			await vi.waitFor(async () => {
				const text = await screen();
				expect(text).toContain("short output");
				expect(text).not.toContain("tool row 1999");
			});
			terminal.write("\x13");
			await vi.waitFor(async () => expect((await events()).some((event) => event.event === "streamed")).toBe(true));
			await vi.waitFor(async () => expect(await screen()).toContain("stream chunk 30"));
			emulator.resize(65, 18);
			terminal.resize(65, 18);
			await vi.waitFor(async () =>
				expect(
					(await events()).some((event) => event.event === "resized" && event.columns === 65 && event.rows === 18),
				).toBe(true),
			);
			await vi.waitFor(async () => expect(await screen()).toContain("stream chunk 30"));
			terminal.write("\x03");
			expect(await terminal.exited).toBe(0);
			const closed = (await events()).find((event) => event.event === "closed");
			expect((await events()).filter((event) => event.event === "expanded").map((event) => event.value)).toEqual([
				true,
				false,
			]);
			expect((await events()).filter((event) => event.event === "overlay").map((event) => event.visible)).toEqual([
				true,
				false,
			]);
			expect(closed).toMatchObject({ code: 0, raw: false });
			expect(closed.listeners).toEqual(closed.beforeListeners);
			const bytes = Buffer.concat(output).toString();
			expect(bytes).toContain("\x1b[?2004l");
			expect(bytes).toContain("\x1b[?25h");
			if (mode === "fullscreen") expect(bytes).toContain("\x1b[?1049l");
		} finally {
			terminal?.close();
			connection.close();
			replies.dispose();
			emulator.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	},
	20000,
);
