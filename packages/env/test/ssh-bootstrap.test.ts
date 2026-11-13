import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@axi/durable/env";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test, vi } from "vitest";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import {
	acceptHostKey,
	connectSsh,
	deployDaemon,
	detectPlatform,
	forgetHostKey,
	localDaemon,
	HostKeyChangedError,
	HostKeyUnknownError,
	SshError,
	scanHostKey,
	sshConnection,
	type SshTarget,
	type RemotePlatform,
} from "../src/ssh.ts";

async function peerFixture() {
	const directory = await mkdtemp(join(tmpdir(), "axi-ssh-bootstrap-"));
	const ssh = join(directory, "ssh.mjs"),
		plan = join(directory, "plan.json");
	await writeFile(
		ssh,
		`#!/usr/bin/env node
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
const base = new URL("./", import.meta.url);
const commands = JSON.parse(await readFile(new URL("plan.json", base), "utf8"));
const step = commands.shift();
await writeFile(new URL("plan.json", base), JSON.stringify(commands));
if (step?.stream) {
 const command = process.argv.slice(process.argv.indexOf("--") + 2).join(" ");
 await appendFile(new URL("calls.jsonl", base), JSON.stringify({ args: process.argv.slice(2), command, input: "" }) + "\\n");
 const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, SHELL: "/bin/sh" } });
 child.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
 process.stdin.pipe(child.stdin);
 await new Promise(resolve => child.on("exit", code => process.exit(code ?? 1)));
}
const chunks = [];
if (step?.closeInput) closeSync(0);
else for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks), command = process.argv.at(-1);
if (step?.hold) await new Promise(resolve => process.stderr.write("SSH probe still running\\n", resolve));
await appendFile(new URL("calls.jsonl", base), JSON.stringify({ args: process.argv.slice(2), command, input: input.toString("base64") }) + "\\n");
if (!step) { process.stderr.write("Unexpected SSH command"); process.exit(99); }
if (step.hostKey) {
 const setting = process.argv.find(value => value.startsWith("UserKnownHostsFile="));
 const file = setting.slice("UserKnownHostsFile=".length + 1, -1).replaceAll("%%", "%");
 await writeFile(file, step.hostKey + "\\n");
}
if (step.local) {
 const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "inherit", "inherit"] });
 child.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
 child.stdin.end(input);
 child.on("exit", code => process.exit(code ?? 1));
} else if (step.hold) {
 setTimeout(() => process.exit(98), 10000);
} else { process.stdout.write(step.stdout ?? ""); process.stderr.write(step.stderr ?? ""); process.exitCode = step.code ?? 0; }
`,
		{ mode: 0o700 },
	);
	const target: SshTarget = {
		host: "fixture.invalid",
		hostKeyAlias: "fixture",
		knownHostsFile: join(directory, "known_hosts"),
		ssh,
	};
	return {
		directory,
		target,
		async plan(steps: { stdout?: string; stderr?: string; code?: number; local?: boolean; stream?: boolean; hostKey?: string; hold?: boolean; closeInput?: boolean }[]) {
			await writeFile(plan, JSON.stringify(steps));
			await writeFile(join(directory, "calls.jsonl"), "");
		},
		async calls(): Promise<{ command: string; input: string; args: string[] }[]> {
			return (await readFile(join(directory, "calls.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		close: () => rm(directory, { recursive: true, force: true }),
	};
}

test.skipIf(process.platform === "win32").each(["eager", "lazy"])(
	"%s SSH connections verify and restart the real daemon without losing remote files",
	async (mode) => {
		const peer = await peerFixture();
		const home = join(peer.directory, "home with 'quote");
		const options = { ...peer.target, binary: localDaemon(), loginShell: mode === "lazy" };
		try {
			await peer.plan([
				{ stdout: `AXI-ENV-PROBE\nLinux\nx86_64\nGNU/Linux\n${home}\n-\n-\n` },
				{ local: true }, { local: true }, { stream: true },
				{ local: true }, { stream: true },
			]);
			const client = mode === "eager" ? await connectSsh(options) : sshConnection(options);
			const { connection } = client;
			try {
				if (typeof client.remote === "function") expect(client.remote()).toBeUndefined();
				const first = await connection.info();
				const env = new RemoteExecutionEnv({ connection, id: "ssh-restart", cwd: peer.directory, shellPath: "/bin/sh" });
				getOrThrow(await env.writeFile("retained.txt", "saved before disconnect", context));
				process.kill(first.pid, "SIGTERM");
				await vi.waitFor(async () => expect((await connection.info()).pid).not.toBe(first.pid));
				expect(getOrThrow(await env.readTextFile("retained.txt", context))).toBe("saved before disconnect");
				const calls = await peer.calls();
				expect(calls).toHaveLength(6);
				expect(calls.filter(({ command }) => command.includes("AXI-ENV-PROBE"))).toHaveLength(1);
				if (typeof client.remote === "function") expect(client.remote()).toMatchObject({ home, platform: "linux" });
			} finally {
				connection.close();
			}
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"stalled SSH platform probes terminate at their deadlines and retain diagnostic output",
	async () => {
		const peer = await peerFixture();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await peer.plan([{ hold: true }, { hold: true }]);
			const pending = detectPlatform(peer.target);
			const rejected = expect(pending).rejects.toMatchObject({
				exitCode: null,
				stderr: "SSH probe still running\n",
				message: expect.stringContaining("did not finish within 60 s"),
			});
			await vi.waitFor(async () => expect(await peer.calls()).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.waitFor(async () => expect(await peer.calls()).toHaveLength(2));
			await vi.advanceTimersByTimeAsync(60_000);
			await rejected;
		} finally {
			vi.useRealTimers();
			await peer.close();
		}
	},
);

test("a refused host-key change does not block a queued update or later removal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-host-key-recovery-"));
	const file = join(directory, "known_hosts");
	const original = { host: "one", hostKeyAlias: "one", knownHostsFile: file };
	const next = { host: "two", hostKeyAlias: "two", knownHostsFile: file };
	try {
		await acceptHostKey(original, ["one ssh-ed25519 AAAA"]);
		const refused = acceptHostKey(original, ["one ssh-ed25519 AQAB"]);
		const accepted = acceptHostKey(next, ["two ssh-ed25519 AQAB"]);
		await expect(refused).rejects.toBeInstanceOf(HostKeyChangedError);
		await accepted;
		expect((await readFile(file, "utf8")).trim().split("\n")).toEqual([
			"one ssh-ed25519 AAAA", "two ssh-ed25519 AQAB",
		]);
		await forgetHostKey(original);
		await forgetHostKey(next);
		expect(await readFile(file, "utf8")).toBe("");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"an SSH upload that closes stdin preserves its remote failure and a later deployment can succeed",
	async () => {
		const peer = await peerFixture();
		try {
			const binary = join(peer.directory, "upload-binary");
			await writeFile(binary, Buffer.alloc(4 * 1024 * 1024, 7));
			const remote = { platform: "linux", arch: "x64", home: "/remote", warnings: [] } satisfies RemotePlatform;
			await peer.plan([{ stdout: "missing\n" }, { closeInput: true, stderr: "upload declined", code: 19 }]);
			await expect(deployDaemon(peer.target, remote, binary)).rejects.toMatchObject({ exitCode: 19, stderr: "upload declined" });
			await peer.plan([{ stdout: "present\n" }]);
			expect(await deployDaemon(peer.target, remote, binary)).toMatch(/^\/remote\/\.axi\/mobile\/tools\/axi-env-/);
			expect(await peer.calls()).toHaveLength(1);
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"SSH probes detect supported systems, Windows shells and Android warnings",
	async () => {
		const peer = await peerFixture();
		const probe = (
			system: string,
			machine = "x86_64",
			os = "GNU/Linux",
			home = "/remote",
			temporary = "-",
			preload = "-",
		) => `banner\nAXI-ENV-PROBE\n${system}\n${machine}\n${os}\n${home}\n${temporary}\n${preload}\n`;
		try {
			for (const [output, expected] of [
				[probe("Linux"), { platform: "linux", arch: "x64", home: "/remote", warnings: [] }],
				[probe("Darwin", "arm64"), { platform: "darwin", arch: "arm64", home: "/remote", warnings: [] }],
				[
					probe("Linux", "aarch64", "Android", "/termux"),
					{
						platform: "android",
						arch: "arm64",
						home: "/termux",
						warnings: [
							expect.stringContaining("TMPDIR"),
							expect.stringContaining("LD_PRELOAD"),
							expect.stringContaining("wake-lock"),
						],
					},
				],
				[
					probe("Linux", "aarch64", "Android", "/termux", "/tmp", "/lib/termux-exec.so"),
					{ platform: "android", arch: "arm64", home: "/termux", warnings: [expect.stringContaining("wake-lock")] },
				],
			] satisfies [string, object][]) {
				await peer.plan([{ stdout: output }]);
				expect(await detectPlatform(peer.target)).toEqual(expected);
			}
			for (const shell of ["cmd", "powershell"]) {
				await peer.plan([
					{ stdout: probe("MSYS_NT", "AMD64") },
					{ stdout: probe("Windows", "AMD64", "-", "C:\\Users\\User") },
					{ stdout: shell === "cmd" ? "Windows_NT" : "%OS%" },
				]);
				expect(await detectPlatform(peer.target)).toEqual({
					platform: "windows",
					arch: "x64",
					home: "C:\\Users\\User",
					shell,
					warnings: [],
				});
			}
			await peer.plan([
				{ code: 1, stderr: "sh unavailable" },
				{ stdout: probe("Windows", "ARM64", "-", "C:\\home") },
				{ stdout: "Windows_NT" },
			]);
			expect(await detectPlatform(peer.target)).toMatchObject({ platform: "windows", arch: "arm64", shell: "cmd" });
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"failed SSH probes preserve host-key errors and reject unsupported responses",
	async () => {
		const peer = await peerFixture();
		try {
			for (const [stderr, constructor] of [
				["REMOTE HOST IDENTIFICATION HAS CHANGED", HostKeyChangedError],
				["Host key verification failed", HostKeyUnknownError],
			] as const) {
				await peer.plan([{ code: 255, stderr }]);
				await expect(detectPlatform(peer.target)).rejects.toBeInstanceOf(constructor);
				expect(await peer.calls()).toHaveLength(1);
			}
			for (const [stdout, message] of [
				["no protocol marker", "Unexpected answer"],
				["AXI-ENV-PROBE\nLinux\nriscv64\n", "Unsupported remote architecture"],
				["AXI-ENV-PROBE\nFreeBSD\nx64\n", "Unsupported remote system"],
			]) {
				await peer.plan([{ stdout }, { stdout }]);
				await expect(detectPlatform(peer.target)).rejects.toThrow(message);
			}
			await peer.plan([
				{ code: 19, stderr: "denied" },
				{ code: 20, stderr: "still denied" },
			]);
			await expect(detectPlatform(peer.target)).rejects.toMatchObject({ exitCode: 20, stderr: "still denied" });
			await expect(
				detectPlatform({ ...peer.target, ssh: join(peer.directory, "not-installed") }),
			).rejects.toBeInstanceOf(SshError);
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"Unix deployment executes the real generated upload script and reuses its verified binary",
	async () => {
		const peer = await peerFixture();
		try {
			const binary = join(peer.directory, "binary"),
				bytes = Buffer.from("#!/bin/sh\nprintf ready\\n\n");
			await writeFile(binary, bytes);
			const remote = {
				platform: "linux",
				arch: "x64",
				home: join(peer.directory, "home with 'quote"),
				warnings: [],
			} satisfies RemotePlatform;
			await peer.plan([{ local: true }, { local: true }]);
			const deployed = await deployDaemon(peer.target, remote, binary);
			expect(await readFile(deployed)).toEqual(bytes);
			expect((await stat(deployed)).mode & 0o777).toBe(0o700);
			expect((await stat(join(remote.home, ".axi/mobile/tools"))).mode & 0o777).toBe(0o700);
			expect(await readdir(join(remote.home, ".axi/mobile/tools"))).toEqual([deployed.split("/").at(-1)]);
			await peer.plan([{ local: true }]);
			expect(await deployDaemon(peer.target, remote, binary)).toBe(deployed);
			expect(await peer.calls()).toHaveLength(1);
			await peer.plan([{ stdout: "nohash\n" }]);
			await expect(deployDaemon(peer.target, remote, binary)).rejects.toThrow(/needs sha256sum/);
			await expect(deployDaemon(peer.target, remote, join(peer.directory, "missing"))).rejects.toThrow(/No Axi daemon/);
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"Windows deployment frames the uploaded bytes and verifies the expected content hash",
	async () => {
		const peer = await peerFixture();
		try {
			const binary = join(peer.directory, "binary"),
				bytes = Buffer.from([0, 1, 2, 255]);
			await writeFile(binary, bytes);
			const remote = {
				platform: "windows",
				arch: "arm64",
				home: "C:\\Users\\O'Brian",
				warnings: [],
			} satisfies RemotePlatform;
			await peer.plan([{ stdout: "missing\n" }, { stdout: "deployed\n" }]);
			const path = await deployDaemon(peer.target, remote, binary),
				calls = await peer.calls();
			const hash = createHash("sha256").update(bytes).digest("hex");
			expect(path).toBe(`${remote.home}\\.axi\\mobile\\tools\\axi-env-${hash.slice(0, 32)}.exe`);
			expect(Buffer.from(calls[1]!.input, "base64").toString()).toBe(`${bytes.toString("base64")}\nAXI-ENV-END\n`);
			const script = Buffer.from(calls[1]!.command.split(" ").at(-1)!, "base64").toString("utf16le");
			expect(script).toContain(hash);
			expect(script).toContain("O''Brian");
			await peer.plan([{ stdout: "present\n" }]);
			expect(await deployDaemon(peer.target, remote, binary)).toBe(path);
			expect(await peer.calls()).toHaveLength(1);
		} finally {
			await peer.close();
		}
	},
);

test("concurrent host-key updates preserve other hosts and deduplicate identical keys", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-hostkey-concurrent-"));
	const file = join(directory, "known_hosts");
	const first = { host: "one", hostKeyAlias: "one", knownHostsFile: file };
	const second = { host: "two", hostKeyAlias: "two", knownHostsFile: file };
	try {
		await Promise.all([
			acceptHostKey(first, ["one ssh-ed25519 AAAA"]),
			acceptHostKey(second, ["two ssh-ed25519 AQAB"]),
			acceptHostKey(first, ["one ssh-ed25519 AAAA"]),
		]);
		expect((await readFile(file, "utf8")).trim().split("\n").sort()).toEqual([
			"one ssh-ed25519 AAAA",
			"two ssh-ed25519 AQAB",
		]);
		await expect(acceptHostKey(first, ["one ssh-ed25519 AQAB"])).rejects.toBeInstanceOf(HostKeyChangedError);
		await forgetHostKey(first);
		expect((await readFile(file, "utf8")).trim()).toBe("two ssh-ed25519 AQAB");
		for (const line of ["wrong ssh-ed25519 AAAA", "one unsupported AAAA", "one ssh-ed25519 $bad", "one ssh-ed25519"])
			await expect(acceptHostKey(first, [line])).rejects.toThrow(/Not a host key/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")(
	"host-key discovery fingerprints a received key even when authentication is refused",
	async () => {
		const peer = await peerFixture();
		try {
			const exported = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
			const type = Buffer.from("ssh-ed25519"),
				typeLength = Buffer.alloc(4),
				keyLength = Buffer.alloc(4);
			typeLength.writeUInt32BE(type.length);
			keyLength.writeUInt32BE(32);
			const encoded = Buffer.concat([typeLength, type, keyLength, exported.subarray(-32)]);
			const line = `${peer.target.hostKeyAlias} ssh-ed25519 ${encoded.toString("base64")}`;
			await peer.plan([{ hostKey: line, code: 255, stderr: "Permission denied (publickey)" }]);
			const scanned = await scanHostKey(peer.target);
			expect(scanned.lines).toEqual([line]);
			expect(scanned.fingerprints).toHaveLength(1);
			expect(scanned.fingerprints[0]).toContain(
				"SHA256:" + createHash("sha256").update(encoded).digest("base64").replace(/=+$/, ""),
			);
			expect((await peer.calls())[0]?.args).toContain("StrictHostKeyChecking=accept-new");
			await expect(readFile(peer.target.knownHostsFile)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"host-key discovery rejects missing keys and preserves changed-key failures",
	async () => {
		const peer = await peerFixture();
		try {
			await peer.plan([{ code: 255, stderr: "No ed25519 host key is known" }]);
			await expect(scanHostKey(peer.target)).rejects.toThrow("No host key received");
			await peer.plan([{ code: 255, stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED" }]);
			await expect(scanHostKey(peer.target)).rejects.toBeInstanceOf(HostKeyChangedError);
		} finally {
			await peer.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"eager SSH setup detects and verifies its daemon without opening a protocol stream",
	async () => {
		const peer = await peerFixture();
		try {
			const binary = join(peer.directory, "bootstrap-binary");
			await writeFile(binary, "bootstrap fixture");
			await peer.plan([
				{ stdout: "AXI-ENV-PROBE\nLinux\naarch64\nAndroid\n/remote-home\n-\n-\n" },
				{ stdout: "present\n" },
			]);
			const warnings: string[] = [];
			const { remote, connection } = await connectSsh({
				...peer.target,
				binary,
				onLog: (message) => warnings.push(message),
			});
			try {
				expect(remote).toMatchObject({ platform: "android", arch: "arm64", home: "/remote-home" });
				expect(warnings).toEqual(remote.warnings.map((message) => message + "\n"));
				expect(await peer.calls()).toHaveLength(2);
			} finally {
				connection.close();
			}
		} finally {
			await peer.close();
		}
	},
);
