import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.resolve(process.argv[2] ?? "");
const manifest = JSON.parse(
	readFileSync(path.join(directory, "package.json"), "utf8"),
);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script with npm run verify:packages.");
const consumer = mkdtempSync(path.join(tmpdir(), "axi-packages-"));
function run(args, cwd) {
	const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`Verification failed with exit code ${result.status}.`);
}
try {
	for (const line of readFileSync(path.join(directory, "SHA256SUMS"), "utf8")
		.trim()
		.split("\n")) {
		const [expected, filename] = line.split("  ");
		assert.equal(
			createHash("sha256")
				.update(readFileSync(path.join(directory, filename)))
				.digest("hex"),
			expected,
			filename,
		);
	}
	const dependencies = Object.fromEntries(
		Object.entries(manifest.dependencies).map(([name, file]) => [
			name,
			"file:" + path.resolve(directory, file.slice(5)),
		]),
	);
	const nodeTypes = JSON.parse(readFileSync(path.join(root, "package.json")))
		.devDependencies["@types/node"];
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies,
			devDependencies: { "@types/node": nodeTypes },
		}),
	);
	run(
		[npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"],
		consumer,
	);
	for (const workspace of JSON.parse(
		readFileSync(path.join(root, "package.json")),
	).workspaces) {
		const pkg = JSON.parse(
			readFileSync(path.join(root, workspace, "package.json")),
		);
		const installed = path.join(consumer, "node_modules", pkg.name);
		assert.ok(
			realpathSync(installed).startsWith(realpathSync(consumer) + path.sep),
		);
		const entrypoints = JSON.parse(
			readFileSync(path.join(installed, "package.json")),
		);
		assert.deepEqual(
			entrypoints.exports,
			pkg.exports,
			`${pkg.name}: package exports changed`,
		);
		for (const field of ["main", "types"]) {
			assert.equal(
				typeof entrypoints[field],
				"string",
				`${pkg.name}: missing ${field} entrypoint`,
			);
			assert.ok(
				existsSync(path.resolve(installed, entrypoints[field])),
				`${pkg.name}: missing ${field} file`,
			);
		}
		for (const file of readdirSync(path.join(root, workspace, "dist"), {
			recursive: true,
		})) {
			if (/\.(?:js|d\.ts|json|map)$/.test(file))
				assert.deepEqual(
					readFileSync(path.join(installed, "dist", file)),
					readFileSync(path.join(root, workspace, "dist", file)),
					`${pkg.name}/${file}`,
				);
		}
		if (pkg.files.includes("native")) {
			for (const file of readdirSync(path.join(root, workspace, "native"), {
				recursive: true,
			})) {
				if (/\.(?:c|m|h|mjs|md|node)$/.test(file))
					assert.deepEqual(
						readFileSync(path.join(installed, "native", file)),
						readFileSync(path.join(root, workspace, "native", file)),
						`${pkg.name}/native/${file}`,
					);
			}
		}
		if (pkg.files.includes("docs")) {
			for (const file of readdirSync(path.join(root, workspace, "docs"), {
				recursive: true,
			})) {
				if (file.endsWith(".md"))
					assert.deepEqual(
						readFileSync(path.join(installed, "docs", file)),
						readFileSync(path.join(root, workspace, "docs", file)),
						`${pkg.name}/docs/${file}`,
					);
			}
		}
		for (const file of readdirSync(installed, { recursive: true })) {
			if (
				!file.endsWith(".md") ||
				(file !== "README.md" &&
					!["docs", "examples"].includes(file.split(path.sep)[0]))
			)
				continue;
			const markdown = readFileSync(path.join(installed, file), "utf8");
			for (const [, target] of markdown.matchAll(
				/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
			)) {
				if (target.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(target))
					continue;
				const destination = path.resolve(
					installed,
					path.dirname(file),
					target.split("#")[0],
				);
				assert.ok(
					existsSync(destination),
					`${pkg.name}/${file}: missing linked file ${target}`,
				);
			}
		}
	}
	copyFileSync(
		path.join(root, "scripts/package-smoke.mjs"),
		path.join(consumer, "smoke.mjs"),
	);
	run([path.join(consumer, "smoke.mjs")], consumer);
	const compiler = JSON.parse(readFileSync(path.join(root, "packages/objects/package.json"))).peerDependencies.esbuild;
	const react = JSON.parse(readFileSync(path.join(root, "packages/objects/package.json"))).peerDependencies.react;
	const reactTypes = JSON.parse(readFileSync(path.join(root, "package.json"))).devDependencies["@types/react"];
	run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", `esbuild@${compiler}`, `react@${react}`, `@types/react@${reactTypes}`], consumer);
	copyFileSync(path.join(root, "scripts/package-plugins-smoke.mjs"), path.join(consumer, "plugins-smoke.mjs"));
	run([path.join(consumer, "plugins-smoke.mjs")], consumer);
	copyFileSync(path.join(root, "scripts/package-host-smoke.mjs"), path.join(consumer, "host-smoke.mjs"));
	run([path.join(consumer, "host-smoke.mjs")], consumer);
	const objectsDocs = path.join(consumer, "node_modules/@axi/objects/docs");
	assert.ok(
		readFileSync(path.join(objectsDocs, "guide.md"), "utf8").length > 0,
	);
	const tutorial = readFileSync(path.join(objectsDocs, "tutorial.md"), "utf8");
	const examples = [...tutorial.matchAll(/```ts\n([\s\S]*?)\n```/g)];
	assert.ok(examples.length > 0);
	writeFileSync(
		path.join(consumer, "tutorial.ts"),
		examples.map((example) => example[1]).join("\n\n"),
	);
	run([path.join(consumer, "tutorial.ts")], consumer);
	const cli = spawnSync(
		process.execPath,
		[path.join(consumer, "node_modules/@axi/ai/dist/cli.js"), "--help"],
		{
			cwd: consumer,
			encoding: "utf8",
		},
	);
	assert.equal(cli.status, 0, cli.stderr);
	assert.match(cli.stdout, /Usage: axi-ai/);
	assert.match(cli.stdout, /openai-codex/);
	assert.equal(existsSync(path.join(consumer, "auth.json")), false);
	writeFileSync(
		path.join(consumer, "types.ts"),
		`
import * as ai from "@axi/ai";
import * as objects from "@axi/objects";
import type { Context } from "@axi/objects/context";
import type { AppOptions } from "@axi/objects/app";
import { Files, FilesFolder, type FileWrite, type FileInfo, type FolderListing, copyFiles } from "@axi/objects/app/files";
import type { TerminalOptions } from "@axi/objects/tui/launcher";
import { workerMain } from "@axi/objects/workers/child";
import { uploadSession, type SyncStateStore } from "@axi/objects/sync";
import { registerLazyOAuthFlows } from "@axi/ai/lazy-oauth";
import { registerLazyBedrockProvider } from "@axi/ai/lazy-bedrock-provider";
import { HostProvider } from "@axi/objects/react";
import * as codemode from "@axi/codemode";
import * as durable from "@axi/durable";
import * as env from "@axi/env";
import * as mcp from "@axi/mcp";
import * as telemetry from "@axi/telemetry";
import * as tui from "@axi/tui";
import type { SummaryRequest, BlockedReason } from "@axi/durable";
import { StoreStorage } from "@axi/durable/storage/store";
export const packages = [ai, objects, codemode, durable, env, mcp, telemetry, tui];
export const fileEntries = [Files, FilesFolder, copyFiles];
export const fileTypes = (write: FileWrite, info: FileInfo, listing: FolderListing) => [write.path, info.version, listing.more];
export const reasons = ["missing_task", "task_too_old", "migration_failed"] satisfies BlockedReason[];
// @ts-expect-error Restart-limited tasks settle rather than remaining blocked.
export const removedReason: BlockedReason = "restart_limit";
export const summaryModel = (request: SummaryRequest) => request.model.modelId;
export const observe = (harness: durable.Harness, id: durable.ConversationId, context: Context) =>
  harness.observeConversation(id, { advance() {}, end() {} }, context, { min: 2, max: 4 });
export const watchCall = (call: durable.WatchCall<unknown>) => call.kind;
export const parse = new ai.StreamingJsonParser();
export const sharedStorage = (store: objects.Store, context: Context) => StoreStorage.open(store, "installed", context);
export const appOptions = (options: AppOptions<{kind:"owner"}|{kind:"server"}>) => options;
export const terminalOptions = (options: TerminalOptions) => options;
export const clientProvider = HostProvider;
export const newEntries = [workerMain, uploadSession, registerLazyOAuthFlows, registerLazyBedrockProvider];
export const syncProgress = (progress: SyncStateStore) => progress;
`,
	);
	writeFileSync(
		path.join(consumer, "conversation-types.ts"),
		readFileSync(path.join(root, "packages/durable/test/conversation-types.test-d.ts"), "utf8")
			.replace('"../src/index.ts"', '"@axi/durable"'),
	);
	run(
		[
			path.join(
				path.dirname(
					fileURLToPath(import.meta.resolve("typescript/package.json")),
				),
				"bin/tsc",
			),
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"false",
			"--module",
			"NodeNext",
			"--target",
			"ES2024",
			"--types",
			"node",
			"types.ts",
			"tutorial.ts",
			"conversation-types.ts",
		],
		consumer,
	);
	run(
		[npm, "uninstall", ...Object.keys(dependencies), "--no-audit", "--no-fund"],
		consumer,
	);
	for (const name of Object.keys(dependencies))
		assert.equal(
			existsSync(path.join(consumer, "node_modules", name)),
			false,
			name,
		);
} finally {
	rmSync(consumer, { recursive: true, force: true });
}
