import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acceptHostKey, HostKeyChangedError, sshConnection } from "../src/ssh.ts";

it("checks a queued key against the alias selected when acceptance started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-host-keys-"));
	try {
		const file = join(directory, "known_hosts");
		await writeFile(file, "fixture ssh-ed25519 AAAA\n");
		const target = { host: "unused.test", hostKeyAlias: "fixture", knownHostsFile: file };
		const pending = acceptHostKey(target, ["fixture ssh-ed25519 AQAB"]);
		target.hostKeyAlias = "changed";
		await expect(pending).rejects.toBeInstanceOf(HostKeyChangedError);
		expect(await readFile(file, "utf8")).toBe("fixture ssh-ed25519 AAAA\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")("retries platform detection when warning delivery fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-ssh-retry-"));
	try {
		const peer = join(directory, "peer.mjs");
		await writeFile(
			peer,
			'#!/usr/bin/env node\nconsole.log("AXI-ENV-PROBE\\nLinux\\naarch64\\nAndroid\\n/home/remote\\n-\\n-");\n',
			{ mode: 0o700 },
		);
		let logs = 0;
		const { connection, remote } = sshConnection({
			host: "unused.test",
			hostKeyAlias: "fixture",
			knownHostsFile: join(directory, "known_hosts"),
			ssh: peer,
			onLog() {
				logs++;
				throw new Error("warning delivery failed");
			},
		});
		try {
			await expect(connection.info()).rejects.toThrow("warning delivery failed");
			expect(remote()).toBeUndefined();
			await expect(connection.info()).rejects.toThrow("warning delivery failed");
			expect(remote()).toBeUndefined();
			expect(logs).toBe(2);
		} finally {
			connection.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
