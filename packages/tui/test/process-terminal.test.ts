import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { Connection, localDaemon, openTerminal, type RemoteTerminal } from "@axi/env";

test.skipIf(process.platform === "win32")(
	"a real PTY negotiates keys, preserves paste, handles resize and restores raw input",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		const output: Uint8Array[] = [];
		let terminal: RemoteTerminal | undefined;
		const text = () => Buffer.concat(output).toString();
		try {
			terminal = await openTerminal(connection, {
				cwd: tmpdir(),
				cols: 40,
				rows: 12,
				argv: [process.execPath, fileURLToPath(new URL("./fixtures/process-terminal.mjs", import.meta.url))],
				onData: (bytes) => output.push(bytes),
			});
			await vi.waitFor(() => expect(text()).toContain("READY"));
			terminal.resize(60, 20);
			await vi.waitFor(() => expect(text()).toContain("SIZE:60x20"));
			terminal.write("\x1b[?7u\x1b[?1;2ca\x1b[200~b\nc\x1b[201~d\r");
			expect(await terminal.exited).toBe(0);
			const result = text().match(/RESULT:(\{[^\n]*\})/);
			expect(result?.[1]).toBeTypeOf("string");
			expect(JSON.parse(result![1]!)).toEqual({
				inputs: ["a", "\x1b[200~b\nc\x1b[201~", "d", "\r"],
				kitty: true,
				raw: false,
				tty: true,
				size: [60, 20],
			});
			expect(text()).toContain("\x1b[?2004h");
			expect(text()).toContain("\x1b[?2004l");
		} finally {
			terminal?.close();
			connection.close();
		}
	},
	10000,
);

test("a fresh keyboard report is negotiated after an incomplete unrelated escape sequence", async () => {
	vi.useFakeTimers();
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	const { ProcessTerminal } = await import("../src/terminal.ts");
	const terminal = new ProcessTerminal();
	const inputs: string[] = [];
	try {
		terminal.start(
			(data) => inputs.push(data),
			() => {},
		);
		process.stdin.emit("data", "\x1b[");
		await vi.advanceTimersByTimeAsync(65);
		process.stdin.emit("data", "\x1b[?7u");
		expect(inputs).toEqual(["\x1b["]);
		expect(terminal.kittyProtocolActive).toBe(true);
	} finally {
		terminal.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});
