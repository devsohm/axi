import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Connection, localDaemon, openTerminal } from "../src/index.ts";

test.skipIf(process.platform === "win32")(
	"terminal preserves binary output and ordered input independently of text decoding",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "axi-terminal-"));
		const connection = new Connection({ command: [localDaemon()] });
		try {
			const chunks: Uint8Array[] = [];
			const binary = await openTerminal(connection, {
				cwd,
				cols: 80,
				rows: 24,
				argv: [process.execPath, "-e", "process.stdout.write(Buffer.from([65,255,66]))"],
				onData: (bytes) => chunks.push(bytes),
			});
			expect(await binary.exited).toBe(0);
			expect([...Buffer.concat(chunks)]).toEqual([65, 255, 66]);
			const input = await openTerminal(connection, {
				cwd,
				cols: 80,
				rows: 24,
				argv: ["sh", "-c", "head -c 8000 > captured"],
				onData() {},
			});
			try {
				for (let i = 0; i < 1000; i++) input.write(`${String(i).padStart(7, "0")}\n`);
				expect(await input.exited).toBe(0);
				expect(await readFile(join(cwd, "captured"), "utf8")).toBe(
					Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(7, "0")}\n`).join(""),
				);
			} finally {
				input.close();
			}
		} finally {
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"terminal resize reaches the program and closing ends its foreground job",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		let text = "";
		const terminal = await openTerminal(connection, {
			cwd: tmpdir(),
			cols: 72,
			rows: 19,
			argv: ["/bin/sh", "-i"],
			env: { PS1: "$ " },
			onData(bytes) {
				text += Buffer.from(bytes).toString();
			},
		});
		void terminal.exited.catch(() => {});
		try {
			terminal.write("stty size\n");
			await vi.waitFor(() => expect(text).toContain("19 72"));
			expect(await terminal.foreground()).toBeUndefined();
			terminal.resize(93, 31);
			terminal.write("stty size; sleep 100\n");
			await vi.waitFor(() => expect(text).toContain("31 93"));
			await vi.waitFor(async () => expect(await terminal.foreground()).toMatchObject({ name: "sleep" }));
			terminal.close();
			await expect(terminal.exited).rejects.toMatchObject({ code: "aborted" });
			await expect(terminal.foreground()).rejects.toMatchObject({ code: "EBADF" });
		} finally {
			terminal.close();
			connection.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"terminal startup failures do not prevent later commands on the same connection",
	async () => {
		const connection = new Connection({ command: [localDaemon()] });
		const cwd = await mkdtemp(join(tmpdir(), "axi-terminal-error-"));
		try {
			await expect(
				openTerminal(connection, { cwd: join(cwd, "absent"), cols: 80, rows: 24, onData() {} }),
			).rejects.toMatchObject({ code: "spawn_error" });
			await expect(connection.request("ptyWrite", { target: 999999 })).rejects.toMatchObject({ code: "EBADF" });
			const terminal = await openTerminal(connection, {
				cwd,
				cols: 80,
				rows: 24,
				argv: ["sh", "-c", "exit 7"],
				onData() {},
			});
			expect(await terminal.exited).toBe(7);
		} finally {
			connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
