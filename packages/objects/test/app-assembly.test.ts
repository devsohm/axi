import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTelemetryContext } from "@axi/telemetry";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import * as objects from "../src/index.ts";
import { Files, SignIns, startServer, WorkerInfo, type App, type AppError } from "../src/node/app/index.ts";
import { Http } from "../src/node/http/index.ts";
import { pageScripts } from "../src/node/surfaces/index.ts";
import type { TelemetryBatch } from "../src/telemetry-ingest/index.ts";

type Principal = { readonly kind: "owner" | "server" | "worker" };
const Room = objects.hostKind("room", { name: objects.str() });
const Counter = objects.remote("assembly.counter", {
	version: 1,
	params: { name: objects.str() },
	hostAddress: ({ name }) => Room({ name }),
	variants: {
		main: {
			state: { count: objects.num(), generation: objects.str() },
			methods: {
				add: objects.method(objects.num(), objects.num()),
				info: objects.method(objects.obj({}), objects.unknown()),
			},
		},
	},
});

async function plugin(folder: string, generation: string): Promise<void> {
	await writeFile(
		join(folder, "server.ts"),
		`import { defineFacet, Http } from "@example/api/v1";
export default defineFacet((host, self) => self.contribute(Http, {routes: {
"GET /generation": { public: true, handler: () => ({kind: "json", value: ${JSON.stringify(generation)}}) }
}}));`,
	);
	await writeFile(
		join(folder, "worker.ts"),
		`import { defineFacet, defineState, hostKind, local, method, num, obj, remote, str, unknown, WorkerInfo } from "@example/api/v1";
const Room = hostKind("room", {name: str()});
const Counter = remote("assembly.counter", {version: 1, params: {name: str()}, hostAddress: ({name}) => Room({name}), variants: {main: {
state: {count: num(), generation: str()}, methods: {add: method(num(), num()), info: method(obj({}), unknown())}
}}});
const Count = defineState("count", {version: 1, schema: obj({count: num()}), persist: true, checkpointWhen: () => false, initial: () => ({count: 0})});
const Value = local("assembly.value", {version: 1, params: {}, members: {count: num(), add: method(num(), num())}});
export default defineFacet((host) => {
host.serve(Value, (_params, self) => {
const state = self.state(Count);
return {count: self.derive([state], ([value]) => value.count), add: async (amount, ctx) => {
await state.change((value) => { value.count += amount; }, ctx); return state.value.count;
}};
});
host.serve(Counter, (_params, _principal, self) => {
const state = self.get(Value, {}), info = self.get(WorkerInfo, {});
return {variant: "main", members: {
count: state.count,
generation: self.derive([state.count], () => ${JSON.stringify(generation)}),
add: (amount, ctx) => state.add(amount, ctx),
info: async () => ({address: info.address.value, start: info.start.value})
}};
});
});`,
	);
	for (const kind of ["web", "tui"])
		await writeFile(
			join(folder, `${kind}.ts`),
			`export default { setup() { return ${JSON.stringify(generation)}; } };`,
		);
}

test("the assembled host reloads server, worker and client plugins while preserving worker state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-assembly-")),
		root = join(directory, "plugins"),
		folder = join(root, "counter"),
		web = join(directory, "web.ts"),
		tui = join(directory, "tui.ts"),
		base = join(directory, "base.ts");
	let app: App<Principal> | undefined;
	try {
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "package.json"), JSON.stringify({ name: "counter", type: "module" }));
		await plugin(folder, "first");
		await writeFile(web, 'export const interfaceName = "browser";');
		await writeFile(tui, 'export const interfaceName = "terminal";');
		await writeFile(base, 'export const service = "first";');
		const errors: AppError[] = [],
			batches: TelemetryBatch[] = [],
			starts: string[] = [];
		const telemetry = Object.assign(new InMemoryTelemetryContext(), {
			ingest(batch: TelemetryBatch) {
				batches.push(batch);
				return batch.spans.length;
			},
		});
		app = await startServer<Principal>(
			{
				name: "assembly",
				dataDir: join(directory, "data"),
				root,
				api: {
					name: "@example/api",
					versions: ["v1"],
					modules: { "@example/api/v1": { ...objects, Files, Http, WorkerInfo } },
				},
				kinds: {
					server: { platform: "node" },
					worker: { platform: "node" },
					web: { platform: "browser" },
					tui: { platform: "node" },
				},
				principal: { server: { kind: "server" }, owner: { kind: "owner" }, worker: () => ({ kind: "worker" }) },
				workers: [
					{
						kind: Room,
						entry: fileURLToPath(new URL("./fixtures/app-integrated-worker.ts", import.meta.url)),
						authorize: () => true,
						start: (address) => {
							starts.push(address.key);
							return { stamp: "initial data" };
						},
					},
				],
				base: [base],
				web: { entry: web, page: (request, assets) => pageScripts(assets, request.nonce) },
				tui: { entry: tui },
				telemetry,
				principalAttributes: (principal) => ({ "app.identity": principal.kind }),
				onError: (error) => errors.push(error),
			},
			context,
		);
		const running = app;
		await running.baseWatched;
		expect(errors).toEqual([]);
		expect(running.web?.base).toEqual(expect.any(String));
		expect(running.tui?.base).toEqual(expect.any(String));
		const origin = new URL(running.ownerLink()).origin,
			signIns = await running.host.get(SignIns, {}, context),
			login = await signIns.issue({ principal: { kind: "owner" }, kind: "device", label: "assembly" }, context);
		signIns.release();
		const headers = { authorization: `Bearer ${login.token}` },
			request = (path: string) => fetch(`${origin}${path}`, { headers });
		expect((await fetch(`${origin}/_objects/tui/start`)).status).toBe(401);
		const start = await (await request("/_objects/tui/start")).json();
		expect(start).toMatchObject({ base: running.tui?.base, script: expect.any(String), combined: expect.any(String) });
		expect(await (await fetch(`${origin}/_objects/tui/base`)).json()).toBe(running.tui?.base);
		expect(await (await fetch(`${origin}/_objects/web/base`)).json()).toBe(running.web?.base);
		expect(await (await request(start.script)).text()).toContain("terminal");
		const firstCombined = await (await request(start.combined)).text();
		expect(firstCombined).toContain("first");
		expect(await (await request("/")).text()).toContain("<script");
		expect(await (await request("/generation")).json()).toBe("first");
		const counter = await running.host.get(Counter, { name: "one" }, context);
		try {
			expect(await counter.add(3, context)).toBe(3);
			expect(await counter.info({}, context)).toEqual({
				address: Room({ name: "one" }),
				start: { stamp: "initial data" },
			});
			await plugin(folder, "second");
			await vi.waitFor(() => expect(running.plugins.state.value.dirty).toContain("counter"));
			const rollout = await running.applyChanges(context);
			expect(rollout.stopped).toBeUndefined();
			expect(rollout.steps.map((step) => step.name)).toEqual(["server", "room", "web", "tui"]);
			await vi.waitFor(() => expect(counter.generation.value).toBe("second"));
			expect(counter.count.value).toBe(3);
			expect(await (await request("/generation")).json()).toBe("second");
			const nextStart = await (await request("/_objects/tui/start")).json();
			expect(nextStart.base).toBe(start.base);
			expect(nextStart.combined).not.toBe(start.combined);
			expect(await (await request(nextStart.combined)).text()).toContain("second");
			await writeFile(base, 'export const service = "changed";');
			await vi.waitFor(() => expect(running.plugins.state.value.base).toBe(true));
			await writeFile(base, 'export const service = "first";');
			await vi.waitFor(() => expect(running.plugins.state.value.base).toBe(false));
		} finally {
			counter.release();
		}
		await running.workers.get(Room.kind)!.stop(Room({ name: "one" }), context);
		expect(batches.flatMap((batch) => batch.spans)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					attributes: expect.objectContaining({ "objects.host": Room({ name: "one" }).key, "app.identity": "worker" }),
				}),
			]),
		);
		const restored = await running.host.get(Counter, { name: "one" }, context);
		try {
			expect(restored.count.value).toBe(3);
			expect(restored.generation.value).toBe("second");
		} finally {
			restored.release();
		}
		expect(starts).toEqual([Room({ name: "one" }).key, Room({ name: "one" }).key]);
		expect(errors).toEqual([]);
	} finally {
		await app?.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("failed client bundle builds report their surfaces and keep the authenticated server available", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-assembly-failure-")),
		root = join(directory, "plugins");
	let app: App<Principal> | undefined;
	try {
		await mkdir(root);
		const entry = join(directory, "broken.ts");
		await writeFile(entry, 'import "./missing.ts";');
		const errors: AppError[] = [];
		app = await startServer<Principal>(
			{
				name: "assembly-failure",
				dataDir: join(directory, "data"),
				root,
				api: { name: "@example/api", versions: ["v1"], modules: {} },
				kinds: { server: { platform: "node" }, web: { platform: "browser" }, tui: { platform: "node" } },
				principal: { server: { kind: "server" }, owner: { kind: "owner" } },
				web: { entry, page: () => "Unavailable" },
				tui: { entry },
				onError: (error) => errors.push(error),
			},
			context,
		);
		await app.baseWatched;
		expect(app.web).toEqual({ base: undefined });
		expect(app.tui).toEqual({ base: undefined });
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "base_build", base: "web" }),
				expect.objectContaining({ kind: "base_build", base: "tui" }),
			]),
		);
		const origin = new URL(app.ownerLink()).origin;
		for (const path of ["/_objects/tui/base", "/_objects/web/base"])
			expect((await fetch(`${origin}${path}`)).status).toBe(503);
		await expect(app.plugins.install({ npm: "--invalid", version: "1" }, context)).rejects.toThrow("refused");
		expect((await fetch(`${origin}/_objects/owner`)).status).toBe(200);
	} finally {
		await app?.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}, 15_000);
