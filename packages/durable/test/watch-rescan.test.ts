import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";
import { expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

const watching = vi.hoisted(() => ({
	callbacks: new Map<string, (event: string, name: string) => void>(),
	options: new Map<string, boolean>(),
	install: (_path: string): void => {},
	filesystemTarget: "",
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		statfs: async (...args: Parameters<typeof fs.statfs>) => {
			if (watching.filesystemTarget === "") return fs.statfs(...args);
			if (args[0] === watching.filesystemTarget)
				throw Object.assign(new Error("filesystem query unavailable"), { code: "EACCES" });
			return { ...(await fs.statfs(...args)), type: 0x6969 };
		},
	};
});
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	const { EventEmitter } = await import("node:events");
	return {
		...fs,
		watch(path: string, options: { recursive?: boolean }, callback: (event: string, name: string) => void) {
			watching.callbacks.set(path, callback);
			watching.options.set(path, options.recursive === true);
			watching.install(path);
			return Object.assign(new EventEmitter(), { close: () => watching.callbacks.delete(path) });
		},
	};
});

it("checks an ancestor filesystem when the target filesystem query fails", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "axi-watch-mode-"));
	watching.filesystemTarget = cwd;
	vi.stubGlobal("process", { ...process, platform: "linux" });
	try {
		const watcher = getOrThrow(
			await new NodeExecutionEnv({ cwd }).watch([{ path: "." }], () => {}, BACKGROUND_CONTEXT),
		);
		try {
			expect(watcher.mode).toBe("polling");
		} finally {
			await watcher.close(BACKGROUND_CONTEXT);
		}
	} finally {
		watching.filesystemTarget = "";
		vi.unstubAllGlobals();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("selects recursive native handles according to the platform", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "axi-watch-"));
	const nested = join(cwd, "nested");
	mkdirSync(nested);
	try {
		for (const platform of ["darwin", "linux"]) {
			vi.stubGlobal("process", { ...process, platform });
			watching.options.clear();
			const watcher = getOrThrow(
				await new NodeExecutionEnv({ cwd, watch: { mode: "native" } }).watch(
					[{ path: ".", recursive: true }],
					() => {},
					BACKGROUND_CONTEXT,
				),
			);
			try {
				expect.soft(watching.options.get(cwd)).toBe(platform === "darwin");
				expect.soft(watching.options.has(nested)).toBe(platform === "linux");
			} finally {
				await watcher.close(BACKGROUND_CONTEXT);
			}
		}
	} finally {
		vi.unstubAllGlobals();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("keeps native watching when a handle fails without an operating-system error code", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "axi-watch-"));
	watching.install = () => {
		throw new Error("unavailable");
	};
	try {
		const watcher = getOrThrow(
			await new NodeExecutionEnv({ cwd, watch: { mode: "native" } }).watch(
				[{ path: "." }],
				() => {},
				BACKGROUND_CONTEXT,
			),
		);
		try {
			expect(watcher.mode).toBe("native");
		} finally {
			await watcher.close(BACKGROUND_CONTEXT);
		}
	} finally {
		watching.install = () => {};
		watching.callbacks.clear();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("stops acquiring native handles when watch capacity forces polling", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "axi-watch-"));
	const changes: string[] = [];
	let attempts = 0;
	let overflows = 0;
	watching.install = () => {
		if (++attempts === 1) throw Object.assign(new Error("Watch capacity exhausted"), { code: "ENOSPC" });
	};
	try {
		const watcher = getOrThrow(
			await new NodeExecutionEnv({ cwd, watch: { mode: "native", pollIntervalMs: 10 } }).watch(
				[{ path: ".", recursive: true }],
				(change) => {
					if ("overflow" in change) overflows++;
					if ("paths" in change) changes.push(...change.paths);
				},
				BACKGROUND_CONTEXT,
			),
		);
		try {
			expect(watcher.mode).toBe("polling");
			expect(overflows).toBe(1);
			expect(attempts).toBe(1);
			const path = join(cwd, "created");
			writeFileSync(path, "value");
			await expect.poll(() => changes, { timeout: 2000 }).toContain(path);
		} finally {
			await watcher.close(BACKGROUND_CONTEXT);
		}
	} finally {
		watching.install = () => {};
		watching.callbacks.clear();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux")(
	"retains changes found before a new directory watcher is installed",
	async () => {
		const cwd = mkdtempSync(join(tmpdir(), "axi-watch-"));
		const changes: string[] = [];
		const watcher = getOrThrow(
			await new NodeExecutionEnv({ cwd, watch: { mode: "native" } }).watch(
				[{ path: ".", recursive: true }],
				(change) => {
					if ("paths" in change) changes.push(...change.paths);
				},
				BACKGROUND_CONTEXT,
			),
		);
		try {
			const directory = join(cwd, "new");
			const transient = join(directory, "transient");
			mkdirSync(directory);
			writeFileSync(transient, "value");
			watching.install = (path) => {
				if (path === directory) rmSync(transient);
			};
			watching.callbacks.get(cwd)?.("rename", "new");
			await expect.poll(() => changes, { timeout: 2000 }).toContain(transient);
		} finally {
			watching.install = () => {};
			await watcher.close(BACKGROUND_CONTEXT);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
