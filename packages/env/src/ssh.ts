import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, type ConnectionOptions } from "./connection.ts";

export interface RemotePlatform {
	platform: "linux" | "android" | "darwin" | "windows";
	arch: "x64" | "arm64";
	home: string;
	shell?: "cmd" | "powershell";
	warnings: string[];
}
export interface SshTarget {
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	knownHostsFile: string;
	hostKeyAlias: string;
	ssh?: string;
	configFile?: string;
}
export interface SshConnectOptions extends SshTarget {
	binary?: string;
	loginShell?: boolean;
	onLog?: ConnectionOptions["onLog"];
}
export class HostKeyUnknownError extends Error {}
export class HostKeyChangedError extends Error {}
export class SshError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;
	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function field(name: string, value: string): void {
	if (!value || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value))
		throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
}
function optionPath(name: string, value: string): string {
	if (!value || /["\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
	return `"${value.replaceAll("%", "%%")}"`;
}
export function sshArguments(
	target: SshTarget,
	strictHostKeys = true,
	knownHostsFile = target.knownHostsFile,
): string[] {
	field("host", target.host);
	field("host key alias", target.hostKeyAlias);
	if (target.user !== undefined) field("user", target.user);
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
		throw new Error(`Invalid port: ${target.port}`);
	const args = [...(target.configFile === undefined ? [] : ["-F", target.configFile]), "-T", "-a", "-x"];
	for (const setting of [
		"BatchMode=yes",
		"ClearAllForwardings=yes",
		"ForwardAgent=no",
		"ForwardX11=no",
		"ControlMaster=no",
		"ControlPath=none",
		"RemoteCommand=none",
		"PermitLocalCommand=no",
		"SendEnv=-*",
		"ServerAliveInterval=15",
		`StrictHostKeyChecking=${strictHostKeys ? "yes" : "accept-new"}`,
		`UserKnownHostsFile=${optionPath("known hosts file", knownHostsFile)}`,
		"GlobalKnownHostsFile=none",
		"HashKnownHosts=no",
		`HostKeyAlias=${target.hostKeyAlias}`,
	])
		args.push("-o", setting);
	if (target.user !== undefined) args.push("-l", target.user);
	if (target.port !== undefined) args.push("-p", String(target.port));
	if (target.identityFile !== undefined)
		args.push("-o", `IdentityFile=${optionPath("identity file", target.identityFile)}`, "-o", "IdentitiesOnly=yes");
	return [...args, "--", target.host];
}
function run(
	target: SshTarget,
	command: string,
	options: { stdin?: Uint8Array; args?: string[]; timeoutMs?: number } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = options.args ?? sshArguments(target);
		const child = spawn(target.ssh ?? "ssh", [...args, command], {
				stdio: ["pipe", "pipe", "pipe"],
			}),
			out: Buffer[] = [],
			diagnostic: Buffer[] = [];
		const timeout = options.timeoutMs ?? 60000;
		const timer = setTimeout(() => {
			child.kill();
			const stderr = Buffer.concat(diagnostic).toString("utf8");
			reject(
				new SshError(`ssh ${target.host} did not finish within ${timeout / 1000} s: ${stderr.trim()}`, null, stderr),
			);
		}, timeout);
		child.stdout.on("data", (bytes: Buffer) => out.push(bytes));
		child.stderr.on("data", (bytes: Buffer) => diagnostic.push(bytes));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new SshError(error.message, null, ""));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const stderr = Buffer.concat(diagnostic).toString("utf8");
			if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
			else if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr))
				reject(new HostKeyChangedError(`The host key of ${target.host} changed; remove the old key to continue`));
			else if (/Host key verification failed|No .* host key is known/.test(stderr))
				reject(new HostKeyUnknownError(`The host key of ${target.host} is not trusted yet`));
			else reject(new SshError(`ssh ${target.host} failed with exit code ${code}: ${stderr.trim()}`, code, stderr));
		});
		child.stdin.end(options.stdin ?? new Uint8Array(0));
	});
}
export async function scanHostKey(target: SshTarget): Promise<{ lines: string[]; fingerprints: string[] }> {
	const temporary = await mkdtemp(join(tmpdir(), "axi-env-hostkey-")),
		file = join(temporary, "known_hosts");
	try {
		await run(target, "exit 0", { args: sshArguments(target, false, file) }).catch((error: unknown) => {
			if (!(error instanceof SshError) && !(error instanceof HostKeyUnknownError)) throw error;
		});
		const lines = existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()) : [];
		if (!lines.length) throw new Error(`No host key received from ${target.host}`);
		const fingerprints = await new Promise<string[]>((resolve, reject) => {
			const child = spawn("ssh-keygen", ["-lf", file], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (bytes: Buffer) => {
				output += bytes.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", () => resolve(output.split("\n").filter((line) => line.trim())));
		});
		return { lines, fingerprints };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
const changes = new Map<string, Promise<void>>();
async function updateKnownHosts(file: string, update: (lines: string[]) => string[]): Promise<void> {
	const next = (changes.get(file) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			const previous = existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean) : [],
				lines = update(previous),
				temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
			await writeFile(temporary, lines.length ? lines.join("\n") + "\n" : "", { flag: "wx", mode: 0o600 });
			try {
				await rename(temporary, file);
			} catch (error) {
				await rm(temporary, { force: true });
				throw error;
			}
		});
	changes.set(file, next);
	try {
		await next;
	} finally {
		if (changes.get(file) === next) changes.delete(file);
	}
}
export async function acceptHostKey(target: SshTarget, lines: readonly string[]): Promise<void> {
	const alias = target.hostKeyAlias;
	const accepted = lines.map((input) => {
		const line = input.trim(),
			[host, type, key] = line.split(/\s+/);
		if (
			host !== alias ||
			!type ||
			!key ||
			!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/.test(type) ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(key)
		)
			throw new Error(`Not a host key line for ${alias}: ${JSON.stringify(input)}`);
		return { line, type, key };
	});
	await updateKnownHosts(target.knownHostsFile, (existing) => {
		const trusted = new Map<string, string>();
		for (const line of existing) {
			const [host, type, key] = line.trim().split(/\s+/);
			if (host === alias && type && key) trusted.set(type, key);
		}
		const additions: string[] = [];
		for (const { type, key, line } of accepted) {
			const prior = trusted.get(type);
			if (prior === key) continue;
			if (prior !== undefined)
				throw new HostKeyChangedError(`The ${type} host key of ${target.host} changed; forget the old key first`);
			additions.push(line);
			trusted.set(type, key);
		}
		return [...existing, ...additions];
	});
}
export async function forgetHostKey(target: SshTarget): Promise<void> {
	await updateKnownHosts(target.knownHostsFile, (lines) =>
		lines.filter((line) => line.trim().split(/\s+/)[0] !== target.hostKeyAlias),
	);
}

function encodedPowerShell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
const unixProbe = `sh -c 'echo AXI-ENV-PROBE; uname -s; uname -m; uname -o 2>/dev/null || echo -; printf "%s\\n" "$HOME" "\${TMPDIR:--}" "\${LD_PRELOAD:--}"'`;
const windowsProbe = encodedPowerShell(
	"'AXI-ENV-PROBE'; 'Windows'; [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); '-'; $HOME; '-'; '-'",
);
type Probe = { system: string; machine: string; os: string; home: string; tmpdir: string; preload: string };
function probeOutput(target: SshTarget, output: string): Probe {
	const lines = output.split(/\r?\n/),
		marker = lines.indexOf("AXI-ENV-PROBE");
	if (marker < 0) throw new Error(`Unexpected answer from ${target.host}: ${output.trim()}`);
	const [system = "", machine = "", os = "", home = "", tmpdir = "-", preload = "-"] = lines.slice(marker + 1);
	return { system, machine, os, home, tmpdir, preload };
}
function architecture(value: string): RemotePlatform["arch"] {
	const name = value.toLowerCase();
	if (name === "x86_64" || name === "amd64" || name === "x64") return "x64";
	if (name === "aarch64" || name === "arm64") return "arm64";
	throw new Error(`Unsupported remote architecture: ${value}`);
}
export async function detectPlatform(target: SshTarget): Promise<RemotePlatform> {
	let probe: Probe;
	try {
		probe = probeOutput(target, await run(target, unixProbe));
	} catch (error) {
		if (error instanceof HostKeyUnknownError || error instanceof HostKeyChangedError) throw error;
		probe = probeOutput(target, await run(target, windowsProbe));
	}
	if (/^(MINGW|MSYS|CYGWIN)/.test(probe.system)) probe = probeOutput(target, await run(target, windowsProbe));
	const arch = architecture(probe.machine),
		home = probe.home;
	if (probe.system === "Windows")
		return {
			platform: "windows",
			arch,
			home,
			shell: (await run(target, "echo %OS%")).includes("Windows_NT") ? "cmd" : "powershell",
			warnings: [],
		};
	if (probe.system === "Darwin") return { platform: "darwin", arch, home, warnings: [] };
	if (probe.system !== "Linux") throw new Error(`Unsupported remote system: ${probe.system}`);
	const android = probe.os === "Android",
		warnings: string[] = [];
	if (android) {
		if (probe.tmpdir === "-") warnings.push("TMPDIR is unset; configure it to Termux's $PREFIX/tmp directory.");
		if (!probe.preload.includes("termux-exec"))
			warnings.push("LD_PRELOAD does not include termux-exec; /usr/bin/env script headers may fail.");
		warnings.push("Use termux-wake-lock to prevent Android from suspending the connection.");
	}
	return { platform: android ? "android" : "linux", arch, home, warnings };
}
export function packagedDaemon(remote: Pick<RemotePlatform, "platform" | "arch">): string {
	return join(
		packageRoot,
		"bin",
		`axi-env-${remote.platform}-${remote.arch}`,
		remote.platform === "windows" ? "axi-env.exe" : "axi-env",
	);
}
export function localDaemon(): string {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	if (platform !== "linux" && platform !== "android" && platform !== "darwin" && platform !== "windows")
		throw new Error(`No Axi environment daemon for ${process.platform}`);
	return packagedDaemon({ platform, arch: architecture(process.arch) });
}
const shQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const hashFunction = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else echo none; fi; }`;
export async function deployDaemon(
	target: SshTarget,
	remote: RemotePlatform,
	binary = packagedDaemon(remote),
): Promise<string> {
	if (!existsSync(binary)) throw new Error(`No Axi daemon for ${remote.platform}-${remote.arch} at ${binary}`);
	const bytes = await readFile(binary),
		hash = createHash("sha256").update(bytes).digest("hex"),
		name = `axi-env-${hash.slice(0, 32)}`;
	const file =
		remote.platform === "windows"
			? `${remote.home}\\.axi\\env\\bin\\${name}.exe`
			: `${remote.home}/.axi/env/bin/${name}`;
	let status: string;
	if (remote.platform === "windows")
		status = (
			await run(
				target,
				encodedPowerShell(
					`$f = ${psQuote(file)}; if ((Test-Path -LiteralPath $f) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -eq '${hash}')) { 'present' } else { 'missing' }`,
				),
			)
		)
			.trim()
			.endsWith("present")
			? "present"
			: "missing";
	else
		status =
			(
				await run(
					target,
					`sh -c ${shQuote(`${hashFunction}; f=${shQuote(file)}; if [ -f "$f" ] && [ "$(hash "$f")" = ${hash} ]; then echo present; elif [ "$(hash /dev/null)" = none ]; then echo nohash; else echo missing; fi`)}`,
				)
			)
				.trim()
				.split("\n")
				.at(-1) ?? "missing";
	if (status === "present") return file;
	if (status === "nohash")
		throw new Error(`${target.host} needs sha256sum, shasum or openssl to verify the Axi daemon`);
	if (remote.platform === "windows") {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`$f = ${psQuote(file)}`,
			"$d = Split-Path -Parent $f",
			"New-Item -ItemType Directory -Force -Path $d | Out-Null",
			"$t = Join-Path $d ('.axi-env-' + [guid]::NewGuid().ToString() + '.tmp')",
			"$text = New-Object System.Text.StringBuilder",
			"foreach ($line in $input) { if ($line -eq 'AXI-ENV-END') { break }; [void]$text.Append($line) }",
			"$bytes = [Convert]::FromBase64String($text.ToString())",
			"$out = [IO.File]::Open($t, 'CreateNew', 'Write', 'None'); $out.Write($bytes, 0, $bytes.Length); $out.Close()",
			`if ((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower() -ne '${hash}') { Remove-Item -LiteralPath $t; throw 'Axi daemon upload is corrupt' }`,
			"for ($i = 0; ; $i++) { try { Move-Item -Force -LiteralPath $t -Destination $f; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 } }",
			"Get-ChildItem -LiteralPath $d -Filter 'axi-env-*.exe' | Where-Object { $_.FullName -ne $f } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue }",
			"'deployed'",
		].join("; ");
		await run(target, encodedPowerShell(script), {
			stdin: Buffer.from(bytes.toString("base64").replace(/.{1,76}/g, "$&\n") + "AXI-ENV-END\n"),
			timeoutMs: 300000,
		});
	} else {
		const script = [
			"set -e",
			hashFunction,
			`f=${shQuote(file)}`,
			'd=$(dirname "$f")',
			'mkdir -p "$d"',
			'chmod 700 "$d"',
			't=$(mktemp "$d/.axi-env.XXXXXX")',
			'cat > "$t"',
			`if [ "$(hash "$t")" != ${hash} ]; then rm -f "$t"; echo "Axi daemon upload is corrupt" >&2; exit 1; fi`,
			'chmod 700 "$t"',
			'mv -f "$t" "$f"',
			'for old in "$d"/axi-env-*; do [ "$old" = "$f" ] || rm -f "$old"; done',
			"echo deployed",
		].join("\n");
		await run(target, `sh -c ${shQuote(script)}`, { stdin: bytes, timeoutMs: 300000 });
	}
	return file;
}
type SshState = { remote?: RemotePlatform; verified?: string };
function createConnection(options: SshConnectOptions, state: SshState): Connection {
	return new Connection({
		command: async () => {
			if (!state.remote) {
				const detected = await detectPlatform(options);
				for (const warning of detected.warnings) options.onLog?.(warning + "\n");
				state.remote = detected;
			}
			const file = state.verified ?? (await deployDaemon(options, state.remote, options.binary));
			state.verified = undefined;
			const remote = state.remote;
			const command =
				remote.platform === "windows"
					? remote.shell === "powershell"
						? `& ${psQuote(file)}`
						: file.includes(" ")
							? `"${file}"`
							: file
					: options.loginShell === true
						? `exec "$SHELL" -lc 'exec "$0" "$@"' ${shQuote(file)}`
						: shQuote(file);
			return [options.ssh ?? "ssh", ...sshArguments(options), command];
		},
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
}
export function sshConnection(options: SshConnectOptions): {
	connection: Connection;
	remote(): RemotePlatform | undefined;
} {
	const state: SshState = {};
	return { connection: createConnection(options, state), remote: () => state.remote };
}
export async function connectSsh(
	options: SshConnectOptions,
): Promise<{ connection: Connection; remote: RemotePlatform }> {
	const remote = await detectPlatform(options),
		verified = await deployDaemon(options, remote, options.binary);
	for (const warning of remote.warnings) options.onLog?.(warning + "\n");
	return { connection: createConnection(options, { remote, verified }), remote };
}
