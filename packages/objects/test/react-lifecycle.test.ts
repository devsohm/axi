import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const chromium = [process.env.CHROMIUM_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
	(path): path is string => path !== undefined && existsSync(path),
);

it.skipIf(chromium === undefined)(
	"updates mounted React bindings and releases their subscriptions in Chromium",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "axi-react-"));
		const completed = Promise.withResolvers<unknown>();
		let browser: ChildProcess | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let closed: Promise<void> | undefined;
		const script = join(directory, "view.js");
		const server = createServer((request, response) => {
			if (request.method === "POST" && request.url === "/result") {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					try {
						completed.resolve(JSON.parse(body));
					} catch (error) {
						completed.reject(error);
					}
					response.end();
				});
			} else if (request.url === "/view.js") {
				void readFile(script).then(
					(bytes) => response.writeHead(200, { "content-type": "text/javascript" }).end(bytes),
					(error) => {
						completed.reject(error);
						response.writeHead(500).end();
					},
				);
			} else
				response
					.writeHead(200, { "content-type": "text/html" })
					.end('<div id="app"></div><pre id="result"></pre><script src="/view.js"></script>');
		});
		try {
			await build({
				entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "fixtures/react-lifecycle.ts")],
				outfile: script,
				bundle: true,
				platform: "browser",
				conditions: ["source"],
				define: { "process.env.NODE_ENV": '"production"' },
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("The browser test server did not listen");
			let stderr = "";
			const child = spawn(
				chromium!,
				[
					"--headless",
					"--no-sandbox",
					"--disable-gpu",
					"--disable-dev-shm-usage",
					`--user-data-dir=${join(directory, "profile")}`,
					"--no-first-run",
					`http://127.0.0.1:${address.port}/`,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			browser = child;
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk).slice(-16000);
			});
			closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			child.once("error", completed.reject);
			child.once("exit", (code, signal) =>
				completed.reject(new Error(`Chromium exited before reporting: ${code ?? signal}\n${stderr}`)),
			);
			deadline = setTimeout(
				() => completed.reject(new Error(`The browser did not report its result\n${stderr}`)),
				30000,
			);
			expect(await completed.promise).toEqual({
				value: {
					initial: { status: "live", count: 0, total: 17, draft: "", title: "Ready" },
					changed: { status: "live", count: 1, total: 17, draft: "unfinished input", title: "Ready" },
					translated: { status: "live", count: 1, total: 17, draft: "unfinished input", title: "Prêt", locale: "fr" },
					sameElement: true,
					restoredDraft: "unfinished input",
					replacement: { status: "live", count: 0, total: 17, draft: "", title: "Prêt", locale: "fr" },
					received: ["initial:first", "updated:layout", "replacement:last"],
					releasedCall: true,
					failures: [],
				},
			});
		} finally {
			clearTimeout(deadline);
			browser?.kill();
			const forceClose = setTimeout(() => {
				browser?.kill("SIGKILL");
				browser?.stderr?.destroy();
			}, 2000);
			try {
				await closed;
			} finally {
				clearTimeout(forceClose);
			}
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		}
	},
	45_000,
);
