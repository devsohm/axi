import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, openStore, sqliteBackend } from "../src/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSignIns, SignIns } from "../src/node/app/sign-ins.ts";
import { Files, filesFacet } from "../src/node/app/files.ts";
import { createLayout, workerDirectory } from "../src/node/app/layout.ts";
import { hashToken, matchesHash, secretFile, writeSecret } from "../src/node/app/secrets.ts";
import { EphemeralSignIns } from "../src/node/app/ephemeral-sign-ins.ts";
import { OwnerLink } from "../src/node/app/owner.ts";
import { Pairings } from "../src/node/app/pairing.ts";

it("creates private app paths and atomically retains the first secret", async () => {
	const dir = await mkdtemp(join(tmpdir(), "axi-app-layout-"));
	try {
		const layout = await createLayout(dir),
			value = await secretFile(layout.cookieSecret);
		expect(await secretFile(layout.cookieSecret)).toBe(value);
		expect(matchesHash(value, hashToken(value))).toBe(true);
		expect(await writeSecret(layout.cookieSecret, "replacement", "create")).toBe("exists");
		if (process.platform !== "win32") expect((await stat(layout.cookieSecret)).mode & 0o777).toBe(0o600);
		expect((await readdir(dir)).sort()).toEqual(["cache", "logs", "plugins", "server", "workers"]);
		expect((await readdir(join(dir, "cache"))).sort()).toEqual(["node", "workers"]);
		for (const path of [layout.workerBases, layout.compileCache]) {
			const info = await stat(path);
			expect(info.isDirectory()).toBe(true);
			if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o700);
		}
		expect(workerDirectory(dir, { kind: "project", key: "project|../A", params: {} })).toBe(
			join(dir, "workers", "project", "project%7C%2E%2E%2F%41"),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("expires owner links and consumes each pairing result once", () => {
	vi.useFakeTimers();
	try {
		const owner = new OwnerLink(),
			token = owner.renew();
		expect(owner.consume("wrong")).toBe(false);
		expect(owner.consume(token)).toBe(true);
		expect(owner.consume(token)).toBe(false);
		const expired = owner.renew();
		vi.advanceTimersByTime(600_000);
		expect(owner.consume(expired)).toBe(false);
		const pairings = new Pairings({ perAddress: 1, maxPending: 1 }),
			first = pairings.begin("device", { kind: "anonymous", address: "one" })!;
		expect(pairings.begin("full", { kind: "anonymous", address: "two" })).toBeUndefined();
		expect(pairings.poll(first.poll)).toEqual({ kind: "waiting" });
		pairings.waiting(first.code.toLowerCase())!.token = "approved";
		expect(pairings.poll(first.poll)).toEqual({ kind: "approved", token: "approved" });
		expect(pairings.poll(first.poll)).toBeUndefined();
	} finally {
		vi.useRealTimers();
	}
});

it("keeps ephemeral credentials only while a connection or its grace period remains", () => {
	vi.useFakeTimers();
	try {
		const sessions = new EphemeralSignIns(1, 50);
		sessions.issue("one", "hash", { kind: "user" });
		const close = sessions.linkOpened("one")!;
		vi.advanceTimersByTime(100);
		expect(sessions.get("one")).toBeDefined();
		close();
		close();
		vi.advanceTimersByTime(50);
		expect(sessions.get("one")).toBeUndefined();
		sessions.issue("two", "hash", { kind: "user" });
		sessions.issue("three", "hash", { kind: "user" });
		expect(sessions.get("two")).toBeUndefined();
		sessions.revoke("three");
	} finally {
		vi.useRealTimers();
	}
});

it("persists sign-in hashes and completed uploads through the real SQLite store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "axi-app-data-")),
		path = join(dir, "store.sqlite");
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context),
		host = createHost({ store, onError() {} });
	await host.load(
		[
			{ name: "sessions", facet: createSignIns("cookie-secret").facet },
			{ name: "files", facet: filesFacet(join(dir, "files"), { maxFile: 32, maxTotal: 64 }) },
		],
		context,
	);
	let secret = "";
	try {
		const sessions = await host.get(SignIns, {}, context),
			issued = await sessions.issue({ principal: { kind: "owner" }, label: "test", kind: "device" }, context);
		secret = issued.token.split(".")[1]!;
		expect(issued.cookie).toMatch(/^objects-sign-in=/);
		expect(await sessions.verify(issued.token, context)).toEqual({ kind: "owner" });
		expect(await sessions.verify("constructor.bad", context)).toBeNull();
		expect(sessions.list.value.find((item) => item.id === issued.id)).not.toHaveProperty("hash");
		const files = await host.get(Files, {}, context),
			started = await files.begin({ space: "test", path: "note", mime: "text/plain", source: "test" }, context),
			encode = new TextEncoder();
		if (started.kind !== "upload") throw new Error("expected a new upload");
		const { upload } = started;
		await Promise.all([
			files.append({ upload, offset: 0, bytes: encode.encode("ab") }, context),
			files.append({ upload, offset: 2, bytes: encode.encode("cd") }, context),
		]);
		expect(await files.uploaded(upload, context)).toBe(4);
		const { id } = await files.finish(upload, context);
		expect(new TextDecoder().decode(await files.read({ id, offset: 1, length: 2 }, context))).toBe("bc");
		await expect(
			files.put({ space: "test", path: "large", mime: "binary", source: "test", bytes: new Uint8Array(33) }, context),
		).rejects.toMatchObject({ code: "too_large" });
		await sessions.revoke(issued.id, context);
		expect(await sessions.verify(issued.token, context)).toBeNull();
		files.release();
		sessions.release();
	} finally {
		await host.close(context);
		await store.close(context);
	}
	try {
		const stored = (await readFile(path)).toString("latin1");
		expect(stored).not.toContain(secret);
		expect(stored).toContain(hashToken(secret));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
