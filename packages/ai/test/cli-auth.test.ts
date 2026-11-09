import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";

const terminal = vi.hoisted(() => ({
	answers: new Array<string>(),
	prompts: new Array<string>(),
	close: vi.fn(),
	login: vi.fn<OAuthAuth["login"]>(),
}));
vi.mock("node:readline", () => ({
	createInterface: () => ({
		question(message: string, reply: (value: string) => void) {
			terminal.prompts.push(message);
			reply(terminal.answers.shift() ?? "");
		},
		close: terminal.close,
	}),
}));
vi.mock("../src/providers/all.ts", () => ({
	builtinProviders: () => [
		{ id: "offline", name: "Offline", auth: { oauth: { login: terminal.login } } },
		{ id: "key-only", name: "Key only", auth: {} },
	],
}));
const credential: OAuthCredential = {
	type: "oauth",
	access: "fixture-access",
	refresh: "fixture-refresh",
	expires: 1000,
};

async function run(args: string[], answers: string[] = [], existing?: string) {
	const directory = await mkdtemp(join(tmpdir(), "axi-cli-auth-"));
	const cwd = process.cwd(),
		argv = process.argv,
		exitCode = process.exitCode;
	let stdout = "",
		stderr = "";
	const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const error = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	terminal.answers.splice(0, terminal.answers.length, ...answers);
	terminal.prompts.length = 0;
	terminal.close.mockClear();
	try {
		if (existing !== undefined) await writeFile(join(directory, "auth.json"), existing, { mode: 0o644 });
		process.chdir(directory);
		process.argv = [process.execPath, "axi-ai", ...args];
		process.exitCode = undefined;
		vi.resetModules();
		await import("../src/cli.ts");
		await vi.waitFor(() =>
			expect(stdout.includes("Credentials saved to auth.json") || stderr.startsWith("Error:")).toBe(true),
		);
		const files = await readdir(directory);
		const contents = files.includes("auth.json") ? await readFile(join(directory, "auth.json"), "utf8") : undefined;
		const saved: unknown = contents === undefined ? undefined : JSON.parse(contents);
		return {
			stdout,
			stderr,
			saved,
			files,
			exitCode: process.exitCode,
			mode: contents === undefined ? undefined : (await stat(join(directory, "auth.json"))).mode & 0o777,
			prompts: [...terminal.prompts],
			closed: terminal.close.mock.calls.length,
		};
	} finally {
		process.chdir(cwd);
		process.argv = argv;
		process.exitCode = exitCode;
		out.mockRestore();
		error.mockRestore();
		await rm(directory, { recursive: true, force: true });
	}
}

test.each([undefined, '{"other":{"type":"api_key","key":"other-fixture"}}', "broken JSON"])(
	"successful CLI login writes only the selected credential and preserves readable existing credentials: %s",
	async (existing) => {
		terminal.login.mockResolvedValue(credential);
		const result = await run(["login", "offline"], [], existing);
		expect(result.saved).toEqual({
			...(existing?.startsWith("{") ? { other: { type: "api_key", key: "other-fixture" } } : {}),
			offline: credential,
		});
		expect(result.files).toEqual(["auth.json"]);
		expect({ stderr: result.stderr, closed: result.closed, exitCode: result.exitCode }).toEqual({
			stderr: "",
			closed: 1,
			exitCode: undefined,
		});
		if (process.platform !== "win32") expect(result.mode).toBe(0o600);
	},
);

test("interactive CLI login forwards prompt choices and displays each authorization notification", async () => {
	terminal.login.mockImplementation(async (interaction, options) => {
		expect(interaction.signal.aborted).toBe(false);
		expect(options?.getDeviceId?.()).toMatch(/^[\da-f-]{36}$/);
		interaction.notify({ type: "auth_url", url: "https://auth.invalid/first", instructions: "Use this browser" });
		interaction.notify({ type: "auth_url", url: "https://auth.invalid/second" });
		interaction.notify({ type: "device_code", verificationUri: "https://device.invalid", userCode: "FIXTURE" });
		interaction.notify({ type: "info", message: "Continue in your browser" });
		interaction.notify({ type: "progress", message: "Waiting for confirmation" });
		expect(await interaction.prompt({ type: "text", message: "Account", placeholder: "name" })).toBe("tester");
		expect(await interaction.prompt({ type: "secret", message: "Secret" })).toBe("fake-secret");
		expect(
			await interaction.prompt({
				type: "select",
				message: "Login method",
				options: [
					{ id: "browser", label: "Browser" },
					{ id: "device", label: "Device" },
				],
			}),
		).toBe("device");
		return credential;
	});
	const result = await run(["login"], ["1", "tester", "fake-secret", "2"]);
	expect(result.saved).toEqual({ offline: credential });
	expect(result.closed).toBe(1);
	expect(result.prompts).toEqual(["Enter number (1-1): ", "Account (name): ", "Secret: ", "Enter number (1-2): "]);
	for (const text of [
		"Offline",
		"https://auth.invalid/first",
		"Use this browser",
		"https://auth.invalid/second",
		"https://device.invalid",
		"FIXTURE",
		"Continue in your browser",
		"Waiting for confirmation",
		"1. Browser",
		"2. Device",
	]) {
		expect(result.stdout).toContain(text);
	}
	expect(result.stdout).not.toContain("Key only");
	expect(result.stdout).not.toContain("fake-secret");
});

test("an invalid provider prompt choice closes the terminal without writing credentials", async () => {
	terminal.login.mockImplementation(async (interaction) => {
		await interaction.prompt({
			type: "select",
			message: "Login method",
			options: [{ id: "browser", label: "Browser" }],
		});
		return credential;
	});
	const result = await run(["login", "offline"], ["0"]);
	expect(result).toMatchObject({ stderr: "Error: Invalid selection\n", files: [], closed: 1, exitCode: 1 });
});

test("a non-Error provider rejection still closes the terminal and reports a failed exit", async () => {
	terminal.login.mockRejectedValue("Offline provider unavailable");
	const result = await run(["login", "offline"]);
	expect(result).toMatchObject({ stderr: "Error: Offline provider unavailable\n", files: [], closed: 1, exitCode: 1 });
});
