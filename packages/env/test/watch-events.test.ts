import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import type { FileChange } from "@axi/durable/env";
import { expect, test, vi } from "vitest";
import { Connection, isConnectionLost } from "../src/connection.ts";
import { RemoteWatcher } from "../src/watch.ts";

const peer = [process.execPath, fileURLToPath(new URL("./fixtures/peer.ts", import.meta.url))];

test("watcher delivers polling changes and overflow in order and isolates a failing subscriber", async () => {
	const connection = new Connection({
		command: [
			...peer,
			"--watch-events",
			JSON.stringify([
				{ kind: "ready", mode: "native" },
				{ kind: "change", paths: ["/work/first"] },
				{ kind: "change", mode: "polling", overflow: true },
				{ kind: "change", paths: ["/work/last"] },
			]),
		],
	});
	const changes: FileChange[] = [];
	const watcher = await RemoteWatcher.open(
		connection,
		[{ path: "/work", recursive: true, exclude: { hidden: true, names: ["build"] } }],
		(change) => {
			changes.push(change);
			if (changes.length === 1) throw new Error("subscriber failed");
		},
		{ mode: "native", pollIntervalMs: 20, maxDirectories: 4 },
	);
	try {
		await vi.waitFor(() =>
			expect(changes).toEqual([
				{ kind: "paths", paths: ["/work/first"] },
				{ kind: "overflow" },
				{ kind: "paths", paths: ["/work/last"] },
			]),
		);
		expect(watcher.mode).toBe("polling");
		await watcher.stop(context);
		await watcher.stop(context);
	} finally {
		await watcher.stop(context);
		connection.close();
	}
});

test.each(["permission_denied", "not-a-watch-code"])(
	"a terminal %s event reports one failure and stops delivery",
	async (code) => {
		const connection = new Connection({
			command: [
				...peer,
				"--watch-events",
				JSON.stringify([
					{ kind: "ready", mode: "polling" },
					{ kind: "error", code, message: "watch failed" },
					{ kind: "change", paths: ["must-not-deliver"] },
				]),
			],
		});
		const changes: FileChange[] = [];
		const watcher = await RemoteWatcher.open(connection, [{ path: "/work" }], (change) => changes.push(change));
		try {
			await vi.waitFor(() => expect(changes).toHaveLength(1));
			expect(changes[0]).toMatchObject({
				kind: "failed",
				error: { code: code === "permission_denied" ? code : "invalid", message: "watch failed" },
			});
			expect(watcher.mode).toBe("polling");
		} finally {
			await watcher.stop(context);
			connection.close();
		}
	},
);

test("startup rejection reaches the caller without a change notification", async () => {
	const connection = new Connection({ command: [...peer, "--watch-denied"] });
	const changes: FileChange[] = [];
	try {
		await expect(
			RemoteWatcher.open(connection, [{ path: "/private" }], (change) => changes.push(change)),
		).rejects.toMatchObject({ code: "EACCES", message: "watch denied" });
		expect(changes).toEqual([]);
	} finally {
		connection.close();
	}
});

test("reconnect retries a failed transport and reports a rescan after the next watch opens", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			if (++starts === 2) throw new Error("temporary transport failure");
			return [...peer, "--watch-hold"];
		},
	});
	const changes: FileChange[] = [];
	const watcher = await RemoteWatcher.open(connection, [{ path: "/work" }], (change) => changes.push(change));
	try {
		await expect(connection.request("drop", {})).rejects.toSatisfy(isConnectionLost);
		await vi.waitFor(() => expect(changes).toEqual([{ kind: "overflow" }]), { timeout: 6000 });
		expect(starts).toBe(3);
	} finally {
		await watcher.stop(context);
		connection.close();
	}
}, 8000);

test("a nonrecoverable rejection while reopening ends the watcher with its file error", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => [...peer, ++starts === 1 ? "--watch-hold" : "--watch-denied"],
	});
	const changes: FileChange[] = [];
	const watcher = await RemoteWatcher.open(connection, [{ path: "/work" }], (change) => changes.push(change));
	try {
		await expect(connection.request("drop", {})).rejects.toSatisfy(isConnectionLost);
		await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 3000 });
		expect(changes[0]).toMatchObject({ kind: "failed", error: { code: "permission_denied", message: "watch denied" } });
		expect(starts).toBe(2);
	} finally {
		await watcher.stop(context);
		connection.close();
	}
}, 5000);

test("stopping during reconnect wakes its delay and never starts another daemon", async () => {
	let starts = 0;
	const connection = new Connection({
		command: async () => {
			starts++;
			return [...peer, "--watch-hold"];
		},
	});
	const changes: FileChange[] = [];
	const watcher = await RemoteWatcher.open(connection, [{ path: "/work" }], (change) => changes.push(change));
	try {
		await expect(connection.request("drop", {})).rejects.toSatisfy(isConnectionLost);
		await watcher.stop(context);
		await watcher.stop(context);
		expect(starts).toBe(1);
		expect(changes).toEqual([]);
	} finally {
		connection.close();
	}
});
