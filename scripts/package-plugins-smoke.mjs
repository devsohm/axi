import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as objects from "@axi/objects";
import { BACKGROUND_CONTEXT } from "@axi/objects/context";

for (const component of ["plugins", "http", "workers"])
	assert.doesNotThrow(() => import.meta.resolve(`@axi/objects/${component}`));
const { createPlugins } = await import("@axi/objects/plugins");

const root = await mkdtemp(join(tmpdir(), "axi-package-plugins-"));
const dir = join(root, "sample");
await mkdir(dir);
await writeFile(join(dir, "package.json"), JSON.stringify({ name: "sample", type: "module" }));
await writeFile(
	join(dir, "worker.ts"),
	`
import { constant, defineFacet, local, int } from "@axi/objects";
const Sample = local("sample", {version: 1, params: {}, members: {value: int()}});
export default defineFacet(host => host.serve(Sample, () => ({value: constant(9)})));
`,
);
const plugins = createPlugins(
	{
		roots: [root],
		kinds: { worker: { platform: "node", hostPackages: ["@axi/objects"] } },
		onError(error) {
			throw error;
		},
	},
	BACKGROUND_CONTEXT,
);
const host = objects.createHost({
	onError(error) {
		throw error;
	},
});
try {
	const loaded = await plugins.load(
		host,
		{ kind: "worker", core: [], modules: { "@axi/objects": objects } },
		BACKGROUND_CONTEXT,
	);
	assert.deepEqual(loaded.failed, []);
	const sample = await host.get(
		objects.local("sample", { version: 1, params: {}, members: { value: objects.int() } }),
		{},
		BACKGROUND_CONTEXT,
	);
	assert.equal(sample.value.value, 9);
	sample.release();
	const httpModule = await import("@axi/objects/http");
	const workerModule = await import("@axi/objects/workers");
	const listener = objects.createHost({ principal: { kind: "server" }, onError() {} });
	const http = httpModule.createHttp(
		listener,
		{
			listen: { host: "127.0.0.1", port: 0 },
			onError(error) {
				throw error;
			},
		},
		BACKGROUND_CONTEXT,
	);
	const Runner = objects.hostKind("packed", { id: objects.str() });
	const Remote = objects.remote("packed.remote", {
		version: 1,
		params: { id: objects.str() },
		hostAddress: ({ id }) => Runner({ id }),
		variants: { ready: { state: { value: objects.int() }, methods: {} } },
	});
	const entry = join(root, "worker.mjs");
	await writeFile(
		entry,
		`
import * as objects from ${JSON.stringify(import.meta.resolve("@axi/objects"))};
import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){if(specifier==="esbuild") throw new Error("worker imported esbuild");return next(specifier,context);}});
const { workerMain } = await import(${JSON.stringify(new URL("./node/workers/index.js", import.meta.resolve("@axi/objects")).href)});
const Runner=objects.hostKind("packed",{id:objects.str()});
const Remote=objects.remote("packed.remote",{version:1,params:{id:objects.str()},hostAddress:({id})=>Runner({id}),variants:{ready:{state:{value:objects.int()},methods:{}}}});
workerMain(async ({address,parent,plugins,onClose},context)=>{
 const host=objects.createHost({address,principal:{kind:"worker"},onError(){}});
 onClose(closing=>host.close(closing));host.connect(parent,{principal:{kind:"server"},trusted:true},context);
 await plugins.load(host,{kind:"worker",core:[{name:"packed",facet:objects.defineFacet(h=>h.serve(Remote,()=>({variant:"ready",members:{value:objects.constant(17)}})))}]},context);
}, {hostPackages:{"@axi/objects":objects},redact:()=>({message:"worker failed"}),onError(){}});
`,
	);
	const workers = workerModule.createWorkers(
		listener,
		Runner,
		{
			kind: "worker",
			entry,
			authorize: () => true,
			principal: () => ({ kind: "worker" }),
			start: () => null,
			lock: (address) => `${root}:${address.key}`,
			plugins,
			onOutput() {},
			onError(error) {
				throw error;
			},
		},
		BACKGROUND_CONTEXT,
	);
	try {
		const app = objects.defineFacet((_host, self) =>
			self.contribute(httpModule.Http, {
				routes: {
					"GET /health": { public: true, handler: async () => ({ kind: "json", value: { ready: true } }) },
					"GET /private-health": async () => { throw new Error("Anonymous request reached a private handler"); },
				},
			}),
		);
		assert.deepEqual(
			(
				await listener.load(
					[
						{ name: "transport", facet: http.facet },
						{ name: "app", facet: app },
					],
					BACKGROUND_CONTEXT,
				)
			).failed,
			[],
		);
		const { port } = await http.listening(BACKGROUND_CONTEXT);
		assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ready: true });
		assert.equal((await fetch(`http://127.0.0.1:${port}/private-health`)).status, 401);
		const remote = await listener.get(Remote, { id: "one" }, BACKGROUND_CONTEXT);
		assert.equal(remote.value.value, 17);
		remote.release();
	} finally {
		await workers.close(BACKGROUND_CONTEXT);
		await http.close(BACKGROUND_CONTEXT);
		await listener.close(BACKGROUND_CONTEXT);
	}
} finally {
	await host.close(BACKGROUND_CONTEXT);
	plugins.close();
	await rm(root, { recursive: true, force: true });
}
