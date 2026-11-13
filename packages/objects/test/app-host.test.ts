import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import * as objects from "../src/index.ts";
import { AppInfo, SignIns, startServer, type AppError, type AppOptions } from "../src/node/app/index.ts";
import { Http } from "../src/node/http/index.ts";

type Principal = { readonly kind: "owner" } | { readonly kind: "server" } | { readonly kind: "worker" };

it("runs authenticated app routes, applies plugin changes and restores device sessions after reopening", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "axi-app-host-"))),
		root = join(dir, "plugins"),
		plugin = join(root, "status"),
		dataDir = join(dir, "data");
	await mkdir(plugin, { recursive: true });
	await writeFile(join(plugin, "package.json"), JSON.stringify({ name: "status", type: "module" }));
	const source = (value: string) => `import { defineFacet, Http } from "@example/api/v1";
export default defineFacet((_host,self)=>self.contribute(Http,{routes:{
"GET /status":{public:true,handler:()=>({kind:"json",value:${JSON.stringify(value)}})},
"GET /account":async (_request,context)=>({kind:"json",value:context.principal})
}}));`;
	await writeFile(join(plugin, "server.ts"), source("before"));
	const errors: AppError[] = [],
		options: AppOptions<Principal> = {
			name: "test-app",
			dataDir,
			root,
			api: { name: "@example/api", versions: ["v1"], modules: { "@example/api/v1": { ...objects, Http } } },
			kinds: { server: { platform: "node" } },
			principal: { server: { kind: "server" }, owner: { kind: "owner" }, worker: () => ({ kind: "worker" }) },
			onError: (error) => errors.push(error),
		};
	let app = await startServer(options, context);
	try {
		const origin = async () => `http://127.0.0.1:${(await app.http.listening(context)).port}`;
		const info = await app.host.get(AppInfo, {}, context);
		expect([info.name.value, info.version.value, info.dataDir.value]).toEqual(["test-app", "v1", dataDir]);
		info.release();
		expect(await (await fetch(`${await origin()}/status`)).json()).toBe("before");
		expect((await fetch(`${await origin()}/account`)).status).toBe(401);
		const link = new URL(app.ownerLink()),
			signIn = () =>
				fetch(new URL(link.pathname, link), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token: link.hash.slice(1) }),
				});
		const signedIn = await signIn();
		expect(signedIn.status).toBe(200);
		expect((await signIn()).status).toBe(403);
		const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
		expect(await (await fetch(`${await origin()}/account`, { headers: { cookie } })).json()).toEqual({ kind: "owner" });
		const sessions = await app.host.get(SignIns, {}, context),
			device = await sessions.issue({ principal: { kind: "owner" }, label: "terminal", kind: "device" }, context);
		sessions.release();
		const ownerToken = await readFile(app.ownerTokenFile, "utf8");
		await writeFile(join(plugin, "server.ts"), source("after"));
		await vi.waitFor(() => expect(app.plugins.state.value.dirty).toContain("status"));
		expect((await app.applyChanges(context)).stopped).toBeUndefined();
		expect(await (await fetch(`${await origin()}/status`)).json()).toBe("after");
		await app.close(context);
		app = await startServer(options, context);
		expect(await readFile(app.ownerTokenFile, "utf8")).toBe(ownerToken);
		expect(
			await (await fetch(`${await origin()}/account`, { headers: { authorization: `Bearer ${device.token}` } })).json(),
		).toEqual({ kind: "owner" });
		const restored = await app.host.get(SignIns, {}, context);
		expect(restored.list.value.some((entry) => entry.id === device.id && entry.label === "terminal")).toBe(true);
		await restored.revoke(device.id, context);
		restored.release();
		expect(
			(await fetch(`${await origin()}/account`, { headers: { authorization: `Bearer ${device.token}` } })).status,
		).toBe(401);
		expect(errors).toEqual([]);
	} finally {
		await app.close(context);
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);

it("keeps the server available after a failed worker build and releases its data lock at close", async () => {
	const dir = await mkdtemp(join(tmpdir(), "axi-app-start-"));
	const root = join(dir, "plugins"),
		entry = join(dir, "broken.ts");
	await mkdir(root);
	await writeFile(entry, 'import "./absent.ts";');
	const errors: AppError[] = [];
	const options = {
		name: "startup",
		dataDir: join(dir, "data"),
		root,
		api: { name: "@example/api", versions: ["v1"], modules: {} },
		kinds: { server: { platform: "node" }, worker: { platform: "node" } },
		principal: { server: { kind: "server" }, owner: { kind: "owner" }, worker: () => ({ kind: "worker" }) },
		onError: (error: AppError) => errors.push(error),
	} satisfies AppOptions<Principal>;
	try {
		const started = await startServer<Principal>(
			{
				...options,
				workers: [{ kind: objects.hostKind("broken"), entry, authorize: () => true, start: () => null }],
			},
			context,
		);
		try {
			await started.basesBuilt;
			expect(errors).toMatchObject([{ kind: "base_build", base: "broken" }]);
			expect(errors[0]?.kind === "base_build" ? String(errors[0].error) : "").toContain(
				'Could not resolve "./absent.ts"',
			);
			const address = new URL(started.ownerLink()).origin;
			expect((await fetch(`${address}/_objects/owner`)).status).toBe(200);
		} finally {
			await started.close(context);
		}
		const app = await startServer<Principal>(options, context);
		await app.close(context);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
