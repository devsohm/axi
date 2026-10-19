import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.each([[], ["help"], ["--help"], ["-h"]].map((args) => ({ args })))(
	"indents provider names in help for $args",
	({ args }) => {
		const cli = pathToFileURL(path.resolve(import.meta.dirname, "../src/cli.ts")).href;
		const providers = pathToFileURL(path.resolve(import.meta.dirname, "../src/providers/all.ts")).href;
		const fixture = `export const builtinProviders=()=>[{id:"fixture",name:"Fixture",auth:{oauth:{}}}];`;
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {registerHooks} from "node:module";registerHooks({load(url,context,next){return url===${JSON.stringify(providers)}?{format:"module",shortCircuit:true,source:${JSON.stringify(fixture)}}:next(url,context);}});process.argv=[process.execPath,${JSON.stringify(cli)},...${JSON.stringify(args)}];await import(${JSON.stringify(cli)});`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toBe(
			"Usage: axi-ai <command> [provider]\n\nCommands:\n  login [provider]  Login to an OAuth provider\n  list              List available providers\n\nProviders:\n  fixture              Fixture\n",
		);
	},
);

it.each(["0", "-1", "invalid"])("rejects provider selection %s without starting a login", (input) => {
	const directory = mkdtempSync(path.join(tmpdir(), "axi-login-selection-"));
	const cli = pathToFileURL(path.resolve(import.meta.dirname, "../src/cli.ts")).href;
	const providers = pathToFileURL(path.resolve(import.meta.dirname, "../src/providers/all.ts")).href;
	const fixture = `export const builtinProviders=()=>["first","second"].map(id=>({id,name:id,auth:{oauth:{login:async()=>{throw new Error("Unexpected login")}}}}));`;
	try {
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {registerHooks} from "node:module";registerHooks({load(url,context,next){return url===${JSON.stringify(providers)}?{format:"module",shortCircuit:true,source:${JSON.stringify(fixture)}}:next(url,context);}});process.argv=[process.execPath,${JSON.stringify(cli)},"login"];await import(${JSON.stringify(cli)});`,
			],
			{ cwd: directory, input: `${input}\n`, encoding: "utf8", timeout: 10000 },
		);
		expect(child.status).toBe(1);
		expect(child.stdout).toBe("  1. first\n  2. second\nEnter number (1-2): ");
		expect(child.stderr).toBe("Error: Unknown provider: \n");
		expect(existsSync(path.join(directory, "auth.json"))).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("preserves other stored entries when login saves a credential", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "axi-login-"));
	const retained = { type: "api_key", key: "fixture-existing" };
	const credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 123 };
	const cli = pathToFileURL(path.resolve(import.meta.dirname, "../src/cli.ts")).href;
	const providers = pathToFileURL(path.resolve(import.meta.dirname, "../src/providers/all.ts")).href;
	const fixture = `export const builtinProviders=()=>[{id:"fixture",name:"Fixture",auth:{oauth:{login:async()=>(${JSON.stringify(credential)})}}}];`;
	try {
		writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ retained }));
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {registerHooks} from "node:module";registerHooks({load(url,context,next){return url===${JSON.stringify(providers)}?{format:"module",shortCircuit:true,source:${JSON.stringify(fixture)}}:next(url,context);}});process.argv=[process.execPath,${JSON.stringify(cli)},"login","fixture"];await import(${JSON.stringify(cli)});`,
			],
			{ cwd: directory, encoding: "utf8", timeout: 10000 },
		);
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(readFileSync(path.join(directory, "auth.json"), "utf8"))).toEqual({
			retained,
			fixture: credential,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
