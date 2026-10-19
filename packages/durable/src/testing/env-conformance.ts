import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@axi/chord/context";
import {
	type ExecutionEnv,
	type FileInfo,
	getOrThrow,
	type ListFilesOptions,
	type Result,
	type WatchChange,
	type WatchTarget,
} from "../env/index.ts";
import type { EnvConformanceCase, EnvConformanceOptions } from "./types.ts";

const encode = new TextEncoder(),
	decode = new TextDecoder();
const code = (result: Result<unknown, { code: string }>): string | undefined =>
	result.ok ? undefined : result.error.code;
function cancelled() {
	const controller = new AbortController();
	controller.abort();
	return withAbortSignal(controller.signal, context);
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function files(env: ExecutionEnv, names: readonly string[]): Promise<void> {
	for (const name of names) getOrThrow(await env.writeFile(name, "", context));
}
async function listing(
	env: ExecutionEnv,
	path: string,
	options?: ListFilesOptions,
): Promise<{ entries: string[]; truncated: boolean }> {
	if (!env.listFiles) throw new Error("The environment does not implement listFiles");
	const value = getOrThrow(await env.listFiles(path, options, context));
	const kinds = { file: "f", directory: "d", symlink: "l" };
	return { entries: value.entries.map((entry) => `${kinds[entry.kind]} ${entry.path}`), truncated: value.truncated };
}
async function collect(env: ExecutionEnv, command: string | readonly string[], cwd?: string) {
	let stdout = "",
		stderr = "";
	const result = await env.exec(
		command,
		{
			...(cwd === undefined ? {} : { cwd }),
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") stdout += text;
				else stderr += text;
			},
		},
		context,
	);
	return { result, stdout, stderr };
}
async function watching(
	env: ExecutionEnv,
	targets: readonly WatchTarget[],
	run: (helpers: {
		changes: WatchChange[];
		absolute(path: string): Promise<string>;
		change(path: string, write: () => Promise<void>): Promise<void>;
	}) => Promise<void>,
): Promise<void> {
	const changes: WatchChange[] = [];
	const watch = getOrThrow(await env.watch(targets, (value) => changes.push(value), context));
	const absolute = async (path: string) => getOrThrow(await env.absolutePath(path, context));
	try {
		await run({
			changes,
			absolute,
			async change(path, write) {
				const full = await absolute(path),
					start = changes.length;
				await write();
				const deadline = Date.now() + 3000;
				while (
					!changes
						.slice(start)
						.some(
							(value) =>
								"overflow" in value ||
								("paths" in value &&
									value.paths.some(
										(parent) => full === parent || full.startsWith(`${parent}/`) || full.startsWith(`${parent}\\`),
									)),
						)
				) {
					if (Date.now() > deadline)
						throw new Error(`No change reported ${full}; got ${JSON.stringify(changes.slice(start))}`);
					await pause(20);
				}
			},
		});
	} finally {
		await watch.close(context);
	}
}

export function createEnvConformance(options: EnvConformanceOptions): readonly EnvConformanceCase[] {
	const a = options.assertions,
		shell = options.shell ?? ["sh", "-c"];
	const cases: EnvConformanceCase[] = [];
	const add = (name: string, test: (env: ExecutionEnv) => Promise<void>, timeoutMs?: number) => {
		cases.push({ name, ...(timeoutMs === undefined ? {} : { timeoutMs }), run: () => options.withEnv(test) });
	};
	const watchCase = (name: string, test: (env: ExecutionEnv) => Promise<void>) => add(name, test, 30000);
	add("binary reader reads byte ranges of the opened file", async (env) => {
		getOrThrow(await env.writeFile("range", "hello world", context));
		const reader = getOrThrow(await env.openBinaryReader("range", undefined, context));
		a.partialDeepEqual(getOrThrow(await reader.info(context)), { name: "range", kind: "file", size: 11 });
		for (const [offset, length, expected] of [
			[0, 5, "hello"],
			[6, 100, "world"],
			[11, 4, ""],
			[50, 1, ""],
			[3, 0, ""],
		] as const) {
			const bytes = getOrThrow(await reader.read(offset, length, context));
			if (expected === "") a.strictEqual(bytes.length, 0);
			else a.strictEqual(decode.decode(bytes), expected);
		}
		a.strictEqual(code(await reader.read(-1, 1, context)), "invalid");
		a.strictEqual(code(await reader.read(0, 1.5, context)), "invalid");
		a.strictEqual(code(await reader.read(0, 1, cancelled())), "aborted");
		await reader.close(context);
		await reader.close(context);
		a.strictEqual(code(await reader.read(0, 1, context)), "invalid");
		a.strictEqual(code(await reader.info(context)), "invalid");
	});
	add("binary reader scans lines like decoding the whole file", async (env) => {
		const bytes = Uint8Array.from([239, 187, 191, 97, 10, 226, 130, 10, 10, 239, 187, 191, 98, 10, 195, 169]);
		getOrThrow(await env.writeFile("lines", bytes, context));
		const lines = decode.decode(bytes).split("\n");
		const reader = getOrThrow(await env.openBinaryReader("lines", undefined, context));
		try {
			for (const [startLine, endLine] of [
				[0, undefined],
				[0, 1],
				[1, 3],
				[2, 3],
				[3, undefined],
				[4, 9],
			] as const) {
				const scan = getOrThrow(
					await reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, context),
				);
				const selected = lines.slice(startLine, endLine).join("\n");
				const range = (start: number, end: number) =>
					new TextDecoder("utf-8", { ignoreBOM: start > 0 }).decode(bytes.subarray(start, end));
				a.strictEqual(scan.newlines, lines.length - 1);
				a.strictEqual(range(scan.start, scan.end), selected);
				a.strictEqual(scan.selectedBytes, encode.encode(selected).length);
				a.strictEqual(range(scan.start, scan.firstLineEnd), lines[startLine]);
				a.strictEqual(scan.firstLineBytes, encode.encode(lines[startLine]).length);
			}
			a.partialDeepEqual(getOrThrow(await reader.scanLines({ startLine: 9 }, context)), {
				start: bytes.length,
				end: bytes.length,
				selectedBytes: 0,
			});
			a.strictEqual(code(await reader.scanLines({ startLine: 2, endLine: 2 }, context)), "invalid");
		} finally {
			await reader.close(context);
		}
	});
	add("binary reader keeps reading the file it opened after a rename", async (env) => {
		getOrThrow(await env.writeFile("old", "one", context));
		const reader = getOrThrow(await env.openBinaryReader("old", undefined, context));
		try {
			getOrThrow(await env.renameFile("old", "moved", context));
			getOrThrow(await env.writeFile("old", "two", context));
			a.strictEqual(decode.decode(getOrThrow(await reader.read(0, 10, context))), "one");
		} finally {
			await reader.close(context);
		}
	});
	add("binary reader refuses directories, missing files and aborted opens", async (env) => {
		getOrThrow(await env.createDir("dir", undefined, context));
		getOrThrow(await env.writeFile("file", "x", context));
		a.strictEqual(code(await env.openBinaryReader("dir", undefined, context)), "is_directory");
		a.strictEqual(code(await env.openBinaryReader("absent", undefined, context)), "not_found");
		a.strictEqual(code(await env.openBinaryReader("file", undefined, cancelled())), "aborted");
	});
	add("directory reader pages every entry exactly once", async (env) => {
		const names = ["a", "b", "c", "d", "e"];
		for (const name of names) getOrThrow(await env.writeFile(name, name, context));
		getOrThrow(await env.createDir("sub", undefined, context));
		const reader = getOrThrow(await env.openDirReader(".", context));
		const entries: FileInfo[] = [];
		let done = false;
		try {
			for (let page = 0; page < 1000; page++) {
				const next = getOrThrow(await reader.next(2, context));
				a.ok(next.entries.length <= 2);
				entries.push(...next.entries);
				if (next.done) {
					done = true;
					break;
				}
			}
		} finally {
			await reader.close(context);
		}
		a.ok(done);
		a.deepEqual(entries.map((entry) => entry.name).sort(), [...names, "sub"].sort());
		a.partialDeepEqual(
			entries.find((entry) => entry.name === "a"),
			{ kind: "file", size: 1 },
		);
		a.strictEqual(entries.find((entry) => entry.name === "sub")?.kind, "directory");
	});
	add("directory reader reports the end and refuses use after close", async (env) => {
		getOrThrow(await env.createDir("empty", undefined, context));
		const reader = getOrThrow(await env.openDirReader("empty", context));
		for (let index = 0; index < 2; index++)
			a.deepEqual(getOrThrow(await reader.next(10, context)), { entries: [], done: true });
		a.strictEqual(code(await reader.next(0, context)), "invalid");
		a.strictEqual(code(await reader.next(1, cancelled())), "aborted");
		await reader.close(context);
		await reader.close(context);
		a.strictEqual(code(await reader.next(1, context)), "invalid");
	});
	add("directory reader refuses missing paths and files", async (env) => {
		getOrThrow(await env.writeFile("file", "", context));
		a.strictEqual(code(await env.openDirReader("missing", context)), "not_found");
		a.strictEqual(code(await env.openDirReader("file", context)), "not_directory");
		a.strictEqual(code(await env.openDirReader(".", cancelled())), "aborted");
	});
	add("directory reader skips entries removed during enumeration", async (env) => {
		getOrThrow(await env.createDir("dir", undefined, context));
		await files(env, ["dir/x", "dir/y", "dir/z"]);
		const reader = getOrThrow(await env.openDirReader("dir", context));
		try {
			for (const name of ["x", "y", "z"]) getOrThrow(await env.remove(`dir/${name}`, undefined, context));
			const found: FileInfo[] = [];
			for (let index = 0; index < 10; index++) {
				const next = getOrThrow(await reader.next(10, context));
				found.push(...next.entries);
				if (next.done) break;
			}
			a.deepEqual(found, []);
		} finally {
			await reader.close(context);
		}
	});
	watchCase("watch reports a missing file's creation, changes, replacement and removal", (env) =>
		watching(env, [{ path: "AGENTS.md" }], async ({ change }) => {
			for (const text of ["one", "two!"])
				await change("AGENTS.md", async () => {
					getOrThrow(await env.writeFile("AGENTS.md", text, context));
				});
			await change("AGENTS.md", async () => {
				getOrThrow(await env.writeFile("AGENTS.md.tmp", "three", context));
				getOrThrow(await env.renameFile("AGENTS.md.tmp", "AGENTS.md", context));
			});
			await change("AGENTS.md", async () => {
				getOrThrow(await env.writeFile("AGENTS.md", "four", context));
			});
			await change("AGENTS.md", async () => {
				getOrThrow(await env.remove("AGENTS.md", undefined, context));
			});
		}),
	);
	watchCase("watch reports a missing target whose ancestors are created", (env) =>
		watching(env, [{ path: "a/b/c/AGENTS.md" }], async ({ change }) => {
			await change("a/b/c/AGENTS.md", async () => {
				getOrThrow(await env.writeFile("a/b/c/AGENTS.md", "x", context));
			});
		}),
	);
	watchCase("watch follows directories created together with their contents", async (env) => {
		getOrThrow(await env.createDir("skills", undefined, context));
		await watching(env, [{ path: "skills", recursive: true }], async ({ change }) => {
			for (const [path, text] of [
				["skills/a/b/SKILL.md", "one"],
				["skills/a/b/SKILL.md", "two!"],
				["skills/a/b/c/SKILL.md", "deeper"],
			])
				await change(path!, async () => {
					getOrThrow(await env.writeFile(path!, text!, context));
				});
		});
	});
	watchCase("watch keeps watching a path whose parent is renamed and recreated", async (env) => {
		getOrThrow(await env.writeFile("project/.axi/skills/x", "x", context));
		await watching(env, [{ path: "project/.axi/skills", recursive: true }], async ({ change }) => {
			await change("project/.axi/skills", async () => {
				getOrThrow(await env.renameFile("project/.axi", "project/old", context));
			});
			for (const text of ["y", "yy"])
				await change("project/.axi/skills/y", async () => {
					getOrThrow(await env.writeFile("project/.axi/skills/y", text, context));
				});
		});
	});
	watchCase("watch skips excluded entries and reports a rename out of them", async (env) => {
		getOrThrow(await env.createDir("skills", undefined, context));
		await watching(
			env,
			[{ path: "skills", recursive: true, exclude: { hidden: true, names: ["node_modules"] } }],
			async ({ changes, change, absolute }) => {
				getOrThrow(await env.writeFile("skills/node_modules/dependency/SKILL.md", "x", context));
				getOrThrow(await env.writeFile("skills/.draft", "draft", context));
				await change("skills/SKILL.md", async () => {
					getOrThrow(await env.renameFile("skills/.draft", "skills/SKILL.md", context));
				});
				const hidden = [await absolute("skills/node_modules"), await absolute("skills/.draft")];
				for (const event of changes)
					if ("paths" in event)
						for (const path of event.paths)
							a.ok(!hidden.some((item) => path === item || path.startsWith(item)), `excluded ${path}`);
			},
		);
	});
	watchCase("watch keeps recursive coverage where a non-recursive target overlaps", async (env) => {
		getOrThrow(await env.writeFile("skills/a/one", "one", context));
		await watching(env, [{ path: "skills" }, { path: "skills", recursive: true }], async ({ change }) => {
			await change("skills/a/two", async () => {
				getOrThrow(await env.writeFile("skills/a/two", "two", context));
			});
		});
	});
	watchCase("watch follows a directory replaced at the same path", async (env) => {
		getOrThrow(await env.writeFile("skills/a/x", "x", context));
		await watching(env, [{ path: "skills", recursive: true }], async ({ change }) => {
			await change("skills/a", async () => {
				getOrThrow(await env.renameFile("skills/a", "skills-old", context));
				getOrThrow(await env.createDir("skills/a", undefined, context));
			});
			for (const text of ["y", "yy"])
				await change("skills/a/y", async () => {
					getOrThrow(await env.writeFile("skills/a/y", text, context));
				});
		});
	});
	watchCase("watch stops reporting once closed", async (env) => {
		const changes: WatchChange[] = [];
		const watch = getOrThrow(await env.watch([{ path: "file" }], (event) => changes.push(event), context));
		a.ok(watch.mode === "native" || watch.mode === "polling");
		await watch.close(context);
		await watch.close(context);
		getOrThrow(await env.writeFile("file", "x", context));
		await pause(300);
		a.deepEqual(changes, []);
	});
	add("argv exec passes arguments to the program without shell parsing", async (env) => {
		const value = "it's $(touch pwned) `touch pwned` *; touch pwned";
		const result = await collect(env, [...shell, 'printf "%s|%s" "$1" "$2"', "argv0", value, "a b"]);
		a.strictEqual(getOrThrow(result.result).exitCode, 0);
		a.strictEqual(result.stdout, `${value}|a b`);
		a.strictEqual(getOrThrow(await env.exists("pwned", context)), false);
	});
	add("exec reports the stream of every chunk in both forms", async (env) => {
		const command = "printf out; printf err >&2; printf more";
		for (const cmd of [[...shell, command], command]) {
			const result = await collect(env, cmd);
			a.strictEqual(getOrThrow(result.result).exitCode, 0);
			a.strictEqual(result.stdout, "outmore");
			a.strictEqual(result.stderr, "err");
		}
	});
	add("argv exec honors cwd and exit codes", async (env) => {
		getOrThrow(await env.createDir("sub", undefined, context));
		const result = await collect(env, [...shell, "printf x > made; exit 3"], "sub");
		a.strictEqual(getOrThrow(result.result).exitCode, 3);
		a.strictEqual(getOrThrow(await env.readTextFile("sub/made", context)), "x");
	});
	add("argv exec reports missing programs and empty argv as spawn errors", async (env) => {
		a.strictEqual(code(await env.exec(["axi-conformance-missing-program"], undefined, context)), "spawn_error");
		a.strictEqual(code(await env.exec([], undefined, context)), "spawn_error");
	});
	add("windowed exec keeps the exact tail and counts what it skips", async (env) => {
		let bytes = 0,
			newlines = 0,
			tail = "";
		const window = { maxBytes: 200, maxLines: 5, minIntervalMs: 0, bytesPerSecond: 1_000_000_000 };
		const result = await env.exec(
			[...shell, "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done"],
			{
				window,
				onOutput: (text, _context, info) => {
					if (info.skipped !== undefined) {
						bytes += info.skipped.bytes;
						newlines += info.skipped.newlines;
						tail = "";
						a.ok(encode.encode(text).length > window.maxBytes || text.split("\n").length - 1 > window.maxLines);
					}
					bytes += encode.encode(text).length;
					newlines += text.split("\n").length - 1;
					tail += text;
				},
			},
			context,
		);
		const expected = Array.from({ length: 2000 }, (_, index) => `line-${index}\n`);
		a.strictEqual(getOrThrow(result).exitCode, 0);
		a.strictEqual(bytes, expected.join("").length);
		a.strictEqual(newlines, 2000);
		a.ok(tail.endsWith(expected.slice(-5).join("")));
	});
	add("argv exec distinguishes timeout from abort", async (env) => {
		a.strictEqual(code(await env.exec([...shell, "sleep 2"], { timeout: 0.1 }, context)), "timeout");
		const controller = new AbortController();
		const running = env.exec([...shell, "sleep 2"], undefined, withAbortSignal(controller.signal, context));
		setTimeout(() => controller.abort(), 100);
		a.strictEqual(code(await running), "aborted");
	});
	if (options.listFiles) {
		add("listFiles lists files and directories depth first in name order", async (env) => {
			await files(env, ["b.txt", "a/z.txt", "a/b/c.txt", ".hidden/x", "A.txt"]);
			getOrThrow(await env.createDir("empty", undefined, context));
			const expected = [
				"d .hidden",
				"f .hidden/x",
				"f A.txt",
				"d a",
				"d a/b",
				"f a/b/c.txt",
				"f a/z.txt",
				"f b.txt",
				"d empty",
			];
			a.deepEqual(await listing(env, "."), { entries: expected, truncated: false });
			a.deepEqual((await listing(env, ".", { hidden: false })).entries, expected.slice(2));
			a.deepEqual(await listing(env, "a"), { entries: ["d b", "f b/c.txt", "f z.txt"], truncated: false });
			a.deepEqual(await listing(env, getOrThrow(await env.absolutePath("a", context))), await listing(env, "a"));
			a.deepEqual(await listing(env, "empty"), { entries: [], truncated: false });
		});
		add("listFiles skips what git ignores in work trees, .git, and excluded names", async (env) => {
			await files(env, ["keep.txt", "out/x.js", "sub/keep.txt", "sub/drop.log", "node_modules/m/i.js"]);
			getOrThrow(await env.writeFile(".gitignore", "out/\n*.log\n", context));
			getOrThrow(await env.writeFile("sub/.gitignore", "!keep.txt\n", context));
			a.ok((await listing(env, ".")).entries.includes("f out/x.js"));
			getOrThrow(await env.writeFile(".git/HEAD", "ref: refs/heads/main\n", context));
			getOrThrow(await env.writeFile(".git/info/exclude", "keep.txt\n", context));
			a.deepEqual((await listing(env, ".", { exclude: ["node_modules"] })).entries, [
				"f .gitignore",
				"d sub",
				"f sub/.gitignore",
				"f sub/keep.txt",
			]);
			a.deepEqual((await listing(env, "sub")).entries, ["f .gitignore", "f keep.txt"]);
			const all = (await listing(env, ".", { gitignore: false })).entries;
			a.ok(["f out/x.js", "f node_modules/m/i.js", "f keep.txt"].every((path) => all.includes(path)));
			a.ok(!all.some((path) => path === "d .git" || path.includes(".git/")));
		});
		add("listFiles stops at its bounds and reports truncated", async (env) => {
			await files(env, ["a", "b", "c"]);
			for (const bound of [{ maxEntries: 2 }, { maxBytes: 6 }])
				a.deepEqual(await listing(env, ".", bound), { entries: ["f a", "f b"], truncated: true });
			a.deepEqual(await listing(env, ".", { maxEntries: 3 }), { entries: ["f a", "f b", "f c"], truncated: false });
			a.deepEqual(await listing(env, ".", { maxEntries: 0 }), { entries: [], truncated: true });
			a.strictEqual(code(await env.listFiles!(".", { maxEntries: -1 }, context)), "invalid");
			a.strictEqual(code(await env.listFiles!(".", { timeoutMs: 1.5 }, context)), "invalid");
		});
		add("listFiles fails on missing directories, files, and aborts", async (env) => {
			getOrThrow(await env.writeFile("file", "", context));
			a.strictEqual(code(await env.listFiles!("missing", undefined, context)), "not_found");
			a.strictEqual(code(await env.listFiles!("file", undefined, context)), "not_directory");
			a.strictEqual(code(await env.listFiles!(".", undefined, cancelled())), "aborted");
		});
	}
	if (options.symlinks !== false && options.listFiles)
		add("listFiles lists symbolic links without following them", async (env) => {
			getOrThrow(await env.writeFile("dir/inner.txt", "", context));
			a.strictEqual(
				getOrThrow(
					await env.exec(
						[...shell, "ln -s dir link && ln -s missing dangling && ln -s .. dir/loop"],
						undefined,
						context,
					),
				).exitCode,
				0,
			);
			a.deepEqual((await listing(env, ".")).entries, [
				"l dangling",
				"d dir",
				"f dir/inner.txt",
				"l dir/loop",
				"l link",
			]);
			a.deepEqual((await listing(env, "link")).entries, ["f inner.txt", "l loop"]);
		});
	if (options.symlinks !== false) {
		add("binary reader follows symlinks unless noFollow refuses the final one", async (env) => {
			getOrThrow(await env.writeFile("target", "target", context));
			getOrThrow(await env.writeFile("sub/inner", "inner", context));
			a.strictEqual(
				getOrThrow(await env.exec([...shell, "ln -s target link && ln -s sub dirlink"], undefined, context)).exitCode,
				0,
			);
			const reader = getOrThrow(await env.openBinaryReader("link", undefined, context));
			try {
				a.strictEqual(decode.decode(getOrThrow(await reader.read(0, 10, context))), "target");
			} finally {
				await reader.close(context);
			}
			a.strictEqual(code(await env.openBinaryReader("link", { noFollow: true }, context)), "invalid");
			const inner = getOrThrow(await env.openBinaryReader("dirlink/inner", { noFollow: true }, context));
			try {
				a.strictEqual(decode.decode(getOrThrow(await inner.read(0, 10, context))), "inner");
			} finally {
				await inner.close(context);
			}
		});
		watchCase("watch reports changes to the file a watched symbolic link points to", async (env) => {
			getOrThrow(await env.writeFile("data/real.md", "one", context));
			getOrThrow(await env.createDir("config", undefined, context));
			a.strictEqual(
				getOrThrow(await env.exec([...shell, "ln -s ../data/real.md config/AGENTS.md"], undefined, context)).exitCode,
				0,
			);
			await watching(env, [{ path: "config/AGENTS.md" }], async ({ change }) => {
				await change("config/AGENTS.md", async () => {
					getOrThrow(await env.writeFile("data/real.md", "two!", context));
				});
			});
		});
	}
	return cases;
}
