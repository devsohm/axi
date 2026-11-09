import { mkdir, mkdtemp, readFile, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { hostKind } from "../src/contracts/index.ts";
import { samePrincipal } from "../src/data/internal.ts";
import { AppInfo, Sessions, startServer, type App, type AppOptions } from "../src/node/app/index.ts";

type Identity = { readonly kind: "service" } | { readonly kind: "person"; readonly id: string };
const server: Identity = { kind: "service" },
	owner: Identity = { kind: "person", id: "first" };
const opened: App<Identity>[] = [],
	directories: string[] = [];
afterEach(async () => {
	for (const app of opened.splice(0).reverse()) await app.close(context);
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "axi-owner-"));
	directories.push(dir);
	await mkdir(join(dir, "plugins"));
	const options = {
		name: "accounts",
		dataDir: join(dir, "data"),
		root: join(dir, "plugins"),
		api: { name: "@example/accounts", versions: ["v1"], modules: {} },
		kinds: { server: { platform: "node" } },
		principal: { server, owner },
		onError() {},
	} satisfies AppOptions<Identity>;
	async function start(identity: Identity = owner) {
		const app = await startServer({ ...options, principal: { server, owner: identity } }, context);
		opened.push(app);
		return app;
	}
	return { options, start };
}

it("compares complete principal values and caches their canonical keys", () => {
	expect(samePrincipal({ id: "first", kind: "person" }, owner, context)).toBe(true);
	expect(samePrincipal(undefined, owner, context)).toBe(false);
	expect(samePrincipal({ ...owner, extra: true }, owner, context)).toBe(false);
	let reads = 0;
	const caller = {
		kind: "person",
		get id() {
			reads++;
			return "first";
		},
	};
	for (let i = 0; i < 5; i++) expect(samePrincipal(caller, owner, context)).toBe(true);
	expect(reads).toBe(1);
});

it("starts without workers and signs browser and device credentials in as the configured owner", async () => {
	const { start } = await fixture(),
		app = await start();
	expect(app.workers.size).toBe(0);
	const info = await app.host.get(AppInfo, {}, context);
	expect(info.owner.value).toBe(owner);
	info.release();
	const link = new URL(app.ownerLink());
	const response = await fetch(new URL(link.pathname, link), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: link.hash.slice(1) }),
	});
	expect(response.status).toBe(200);
	const file = (await readFile(app.ownerTokenFile, "utf8")).trim();
	await app.host.root(async (ctx) => {
		const sessions = await ctx.get(Sessions, {});
		expect(await sessions.verify(file, ctx)).toEqual(owner);
		expect(sessions.list.value.map((session) => session.principal)).toEqual([owner, owner]);
	}, context);
});

it("keeps equivalent owners' credentials and revokes only the file credential when ownership changes", async () => {
	const { start } = await fixture();
	const first = await start(),
		token = (await readFile(first.ownerTokenFile, "utf8")).trim();
	const separate = await first.host.root(
		async (ctx) => (await ctx.get(Sessions, {})).issue({ principal: owner, kind: "device", label: "separate" }, ctx),
		context,
	);
	await first.close(context);
	const equal = await start({ id: "first", kind: "person" });
	expect((await readFile(equal.ownerTokenFile, "utf8")).trim()).toBe(token);
	await equal.close(context);
	const nextOwner: Identity = { kind: "person", id: "second" },
		next = await start(nextOwner);
	const replacement = (await readFile(next.ownerTokenFile, "utf8")).trim();
	expect(replacement).not.toBe(token);
	expect((await stat(next.ownerTokenFile)).mode & 0o777).toBe(0o600);
	await next.host.root(async (ctx) => {
		const sessions = await ctx.get(Sessions, {});
		expect(await sessions.verify(token, ctx)).toBeNull();
		expect(await sessions.verify(replacement, ctx)).toEqual(nextOwner);
		expect(await sessions.verify(separate.token, ctx)).toEqual(owner);
	}, context);
});

it("refuses unserializable owners and a server owner before creating persistent data", async () => {
	const { options } = await fixture();
	await expect(startServer({ ...options, principal: { server, owner: server } }, context)).rejects.toThrow(
		"principal.owner must not be the server's principal",
	);
	await expect(
		startServer(
			{ ...options, principal: { server, owner: { ...owner, missing: undefined } as unknown as Identity } },
			context,
		),
	).rejects.toThrow("principal.owner must be strict JSON");
	await expect(access(options.dataDir!)).rejects.toMatchObject({ code: "ENOENT" });
});

function workerTypes(options: AppOptions<Identity>) {
	const worker = { kind: hostKind("job"), entry: "worker.ts", start: () => null, authorize: () => true };
	// @ts-expect-error workers require a worker principal factory
	const invalid: AppOptions<Identity> = { ...options, principal: { server, owner }, workers: [worker] };
	const workers = [] as (typeof worker)[];
	// @ts-expect-error an array may contain worker kinds even when currently empty
	const invalidArray: AppOptions<Identity> = { ...options, principal: { server, owner }, workers };
	return [invalid, invalidArray];
}
void workerTypes;
