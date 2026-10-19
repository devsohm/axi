#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AuthPrompt } from "./auth/types.ts";
import { builtinProviders } from "./providers/all.ts";

const providers = builtinProviders().filter((provider) => provider.auth.oauth !== undefined);
function credentials(): Record<string, unknown> {
	if (!existsSync("auth.json")) return {};
	try {
		return JSON.parse(readFileSync("auth.json", "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}
async function main(args: string[]): Promise<void> {
	const [command, providerId] = args;
	const list = (prefix = "") =>
		providers.map((provider) => `${prefix}${provider.id.padEnd(20)} ${provider.name}`).join("\n");
	if (!command || ["help", "--help", "-h"].includes(command)) {
		process.stdout.write(
			`Usage: axi-ai <command> [provider]\n\nCommands:\n  login [provider]  Login to an OAuth provider\n  list              List available providers\n\nProviders:\n${list("  ")}\n`,
		);
		return;
	}
	if (command === "list") {
		process.stdout.write(`${list()}\n`);
		return;
	}
	if (command !== "login") throw new Error(`Unknown command: ${command}`);
	if (providerId && !providers.some((provider) => provider.id === providerId))
		throw new Error(`Unknown provider: ${providerId}`);
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (text: string): Promise<string> => new Promise((resolve) => terminal.question(text, resolve));
	const prompt = async (question: AuthPrompt): Promise<string> => {
		if (question.type !== "select")
			return ask(`${question.message}${question.placeholder ? ` (${question.placeholder})` : ""}: `);
		process.stdout.write(
			`\n${question.message}\n${question.options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n")}\n`,
		);
		const index = Number.parseInt(await ask(`Enter number (1-${question.options.length}): `), 10) - 1;
		const option = question.options[index];
		if (!option) throw new Error("Invalid selection");
		return option.id;
	};
	try {
		let id = providerId;
		if (!id) {
			for (const [index, provider] of providers.entries()) process.stdout.write(`  ${index + 1}. ${provider.name}\n`);
			const index = Number.parseInt(await ask(`Enter number (1-${providers.length}): `), 10) - 1;
			id = providers[index]?.id;
		}
		const provider = providers.find((provider) => provider.id === id);
		if (!provider?.auth.oauth) throw new Error(`Unknown provider: ${id ?? ""}`);
		const credential = await provider.auth.oauth.login(
			{
				signal: new AbortController().signal,
				prompt,
				notify(event) {
					switch (event.type) {
						case "auth_url":
							process.stdout.write(
								`\nOpen this URL in your browser:\n${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`,
							);
							break;
						case "device_code":
							process.stdout.write(
								`\nOpen this URL in your browser:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`,
							);
							break;
						case "info":
						case "progress":
							process.stdout.write(`${event.message}\n`);
							break;
					}
				},
			},
			{ getDeviceId: randomUUID },
		);
		writeFileSync("auth.json", JSON.stringify({ ...credentials(), [id]: credential }, null, 2), "utf8");
		process.stdout.write("\nCredentials saved to auth.json\n");
	} finally {
		terminal.close();
	}
}
void main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
