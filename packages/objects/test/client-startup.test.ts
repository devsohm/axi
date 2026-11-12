import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	createHost, defineFacet, hostKind, memoryLinkPair, startClient, Translations, translationsFacet, WebScripts,
	type Link, type RegisteredScript, type ScriptEntry, type ScriptSet,
} from "../src/index.ts";
import { publishTo, scriptsFacet } from "../src/node/surfaces/current.ts";

function script(revision: string): RegisteredScript {
	return {
		plugin: "status", digest: revision,
		run(_require, module) {
			module.exports = { default: defineFacet((_host, self) => self.contribute(Translations, [
				{ namespace: "connection", locale: "en", messages: { status: revision } },
			])) };
		},
	};
}
function set(revision: string, base = "application"): ScriptSet {
	return { base, combined: "/plugins.js", plugins: [{ name: "status", digest: revision, url: `/status-${revision}.js` }] };
}
async function setup(options: { offline?: boolean; follow?: boolean; shown?: string } = {}) {
	const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError() {} });
	await server.load([{ name: "scripts", facet: scriptsFacet("web", { set: set(options.shown ?? "initial") }) }], context);
	const links: Link[] = [], fetchScript = vi.fn(async (entry: ScriptEntry) => script(entry.digest)),
		serverBase = vi.fn(async () => "new-application"), outdated = vi.fn();
	let baseReads = 0;
	const client = await startClient({
		scripts: WebScripts, base: "application", initial: [script("initial")], modules: {},
		core: [{ name: "translations", facet: translationsFacet() }], follow: options.follow,
		fetchScript, get serverBase() { baseReads++; return serverBase; }, outdated, onError() {},
		environment: {
			now: Date.now, online: () => true, onWake: () => () => {},
			after(ms, run) { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
		},
		open(events) {
			const [client, remote] = memoryLinkPair();
			links.push(client);
			if (!options.offline) {
				server.accept(remote, { principal: { kind: "user" } }, context);
				queueMicrotask(events.opened);
			}
			return client;
		},
	});
	const registry = await client.host.registry(Translations, context);
	return {
		server, links, fetchScript, serverBase, outdated,
		baseReads: () => baseReads,
		status: () => registry.value.catalogs.get("connection")?.get("en")?.value.messages.status,
		async close() { await client.stop(context); await server.close(context); },
	};
}

it("exposes its bundled plugin before an unavailable server answers the script watch", async () => {
	const running = await setup({ offline: true });
	try {
		expect(running.status()).toBe("initial");
		expect(running.links).toHaveLength(1);
		expect(running.fetchScript).not.toHaveBeenCalled();
	} finally {
		await running.close();
	}
});

it("loads the already-published snapshot and then subsequent script changes", async () => {
	const running = await setup({ shown: "published" });
	try {
		await vi.waitFor(() => expect(running.status()).toBe("published"));
		await publishTo(running.server, "web", set("later"), context);
		await vi.waitFor(() => expect(running.status()).toBe("later"));
		expect(running.fetchScript.mock.calls.map(([entry]) => entry.digest)).toEqual(["published", "later"]);
		expect(running.outdated).not.toHaveBeenCalled();
	} finally {
		await running.close();
	}
});

it("retains static scripts and reconnects without querying a newer server base", async () => {
	const running = await setup({ follow: false });
	try {
		await publishTo(running.server, "web", set("published", "new-application"), context);
		running.links[0]!.close();
		await vi.waitFor(() => expect(running.links).toHaveLength(2));
		expect(running.status()).toBe("initial");
		expect(running.fetchScript).not.toHaveBeenCalled();
		expect(running.serverBase).not.toHaveBeenCalled();
		expect(running.outdated).not.toHaveBeenCalled();
	} finally {
		await running.close();
	}
});

it("captures the server-base callback during startup and calls it without a receiver", async () => {
	const running = await setup();
	try {
		expect(running.baseReads()).toBe(1);
		running.links[0]!.close();
		await vi.waitFor(() => expect(running.outdated).toHaveBeenCalledOnce());
		expect(running.serverBase.mock.contexts).toEqual([undefined]);
		expect(running.baseReads()).toBe(1);
	} finally {
		await running.close();
	}
});
