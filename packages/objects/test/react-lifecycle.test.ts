import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const chromium = [process.env.CHROMIUM_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
	(path): path is string => path !== undefined && existsSync(path),
);

it.skipIf(chromium === undefined)(
	"updates mounted React bindings and releases their subscriptions in Chromium",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-react-"));
		try {
			await build({
				entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/react-lifecycle.ts")],
				outfile: join(directory, "view.js"),
				bundle: true,
				platform: "browser",
				conditions: ["source"],
				define: { "process.env.NODE_ENV": '"production"' },
			});
			const page = join(directory, "view.html");
			await writeFile(page, '<div id="app"></div><pre id="result"></pre><script src="view.js"></script>');
			const { stdout } = await promisify(execFile)(
				chromium!,
				[
					"--headless",
					"--no-sandbox",
					"--disable-gpu",
					"--disable-dev-shm-usage",
					`--user-data-dir=${join(directory, "profile")}`,
					"--dump-dom",
					"--virtual-time-budget=15000",
					pathToFileURL(page).href,
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
			const encoded = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
			expect(encoded, stdout).toBeTruthy();
			const result = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
			expect(result.error, result.stack).toBeUndefined();
			expect(result.value).toEqual({
				initial: { status: "live", count: 0, total: 17, draft: "", title: "Ready" },
				changed: { status: "live", count: 1, total: 17, draft: "unfinished input", title: "Ready" },
				translated: { status: "live", count: 1, total: 17, draft: "unfinished input", title: "Prêt", locale: "fr" },
				sameElement: true,
				restoredDraft: "unfinished input",
				replacement: { status: "live", count: 0, total: 17, draft: "", title: "Prêt", locale: "fr" },
				received: ["initial:first", "updated:layout", "replacement:last"],
				releasedCall: true,
				failures: [],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	45_000,
);
