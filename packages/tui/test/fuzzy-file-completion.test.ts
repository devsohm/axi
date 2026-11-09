import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

test.skipIf(process.platform === "win32")(
	"file mentions merge shallow and deep search, hide Git internals and rank exact matches",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-fuzzy-files-"));
		const fd = join(directory, "fd.mjs"),
			calls = join(directory, "calls.jsonl");
		await mkdir(join(directory, "folder"));
		await writeFile(
			fd,
			`#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const rows = args.includes("--max-depth") ? ["readme", "readme.md", "readme-dir/", ".git/config"] : ["readme", "src/readme", "src/long-readme.md", "readme-path/other.ts", "other.ts", "folder/.git/config", ".git/"];
process.stdout.write(rows.join("\\n") + "\\n");
`,
			{ mode: 0o700 },
		);
		const provider = new CombinedAutocompleteProvider([], directory, fd);
		const suggest = (query: string) =>
			provider.getSuggestions([query], 0, query.length, { signal: new AbortController().signal });
		try {
			const result = await suggest("@readme");
			expect(result?.items.map((item) => item.value)).toEqual([
				"@readme",
				"@src/readme",
				"@readme-dir/",
				"@readme.md",
				"@src/long-readme.md",
				"@readme-path/other.ts",
			]);
			expect(result?.items.filter((item) => item.value === "@readme")).toHaveLength(1);
			const empty = await suggest("@");
			expect(empty?.items.some((item) => item.value === "@other.ts")).toBe(true);
			expect(empty?.items.some((item) => item.value.includes(".git"))).toBe(false);
			const prefixed = await suggest('@"folder/readme');
			expect(prefixed?.items[0]?.value).toBe('@"folder/readme"');
			const missingPrefix = await suggest("@readme-path/other");
			expect(missingPrefix?.items.map((item) => item.value)).toContain("@readme-path/other.ts");
			const args: string[][] = (await readFile(calls, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(args.some((args) => args.includes("--full-path"))).toBe(true);
			expect(args.some((args) => args[args.indexOf("--base-directory") + 1] === join(directory, "folder") + "/")).toBe(
				true,
			);
			expect(args.filter((args) => args.includes("--max-depth"))).toHaveLength(4);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"file search handles missing executables, nonzero exit, empty output and cancellation",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-fuzzy-failures-"));
		try {
			const signal = new AbortController().signal;
			for (const source of ["process.exitCode = 1;", "process.stdout.write('');"]) {
				const fd = join(directory, "fd.mjs");
				await writeFile(fd, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
				expect(
					await new CombinedAutocompleteProvider([], directory, fd).getSuggestions(["@file"], 0, 5, { signal }),
				).toBeNull();
			}
			expect(
				await new CombinedAutocompleteProvider([], directory, join(directory, "missing")).getSuggestions(
					["@file"],
					0,
					5,
					{ signal },
				),
			).toBeNull();
			const fd = join(directory, "slow.mjs"),
				pidFile = join(directory, "pid");
			await writeFile(
				fd,
				`#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
				{ mode: 0o700 },
			);
			const provider = new CombinedAutocompleteProvider([], directory, fd),
				controller = new AbortController();
			const pending = provider.getSuggestions(["@file"], 0, 5, { signal: controller.signal });
			let pid = 0;
			await vi.waitFor(async () => {
				pid = Number(await readFile(pidFile, "utf8"));
				expect(pid).toBeGreaterThan(0);
			});
			controller.abort();
			expect(await pending).toBeNull();
			expect(() => process.kill(pid, 0)).toThrow();
			expect(await provider.getSuggestions(["@file"], 0, 5, { signal: AbortSignal.abort() })).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
