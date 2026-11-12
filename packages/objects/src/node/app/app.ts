import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { TelemetryContext } from "@axi/telemetry";
import { withAbortSignal, type Context } from "../../context/index.ts";
import { hostKind, type Address, type HostKind, type KindShape } from "../../contracts/index.ts";
import { isObjectsError, type Principal } from "../../data/index.ts";
import { principalKey, samePrincipal } from "../../data/principal.ts";
import { createHost, type Host, type HostError, type PluginFacet, type PrincipalAttributes } from "../../host/index.ts";
import { isJsonValue, type JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { decodeJsonl, encodeJsonl, openStore, sqliteBackend } from "../../store/index.ts";
import { localeChoiceFacet, themeChoiceFacet, themesFacet, translationsFacet } from "../../surfaces/index.ts";
import { telemetryIngestFacet, type TelemetryIngestTarget } from "../../telemetry-ingest/index.ts";
import type { Watchable } from "../../watch.ts";
import { createHttp, type HttpComponent, type HttpError, type ListenAddress } from "../http/index.ts";
import {
	createPlugins,
	type BaseInputs,
	type HostPackages,
	type InstallOptions,
	type PluginSource,
	type Plugins,
	type PluginsError,
	type PluginsState,
	type RolloutResult,
} from "../plugins/index.ts";
import {
	processConditions, tuiSurface, webSurface, WEB_PREFIX,
	type TuiSurface, type TuiSurfaceOptions, type WebSurface, type WebSurfaceOptions, type WebRoutesOptions,
} from "../surfaces/index.ts";
import { createWorkers, nodeBaseInputs, processLock, type ProcessLock, type Workers, type WorkersError } from "../workers/index.ts";
import { ARCHIVE_FORMAT, exists, packData, unpackStaging, type ArchiveManifest } from "./archive.ts";
import { addressParam, HostData } from "./data.ts";
import { filesFacet, type FilesCaps } from "./files.ts";
import { appInfoFacet } from "./info.ts";
import { createLayout, defaultDataDir, openDataDir, privateStore, workerDirectory } from "./layout.ts";
import { OWNER_PATH, OwnerLink, ownerFacet, ownerTokenFile } from "./owner.ts";
import { Pairings, pairingFacet } from "./pairing.ts";
import { secretFile } from "./secrets.ts";
import { createSessions } from "./sessions.ts";

export const Server = hostKind("server");
export type AppApi = { readonly name: string; readonly versions: readonly string[]; readonly modules: HostPackages };
export type AppKind = { readonly platform: "node" | "browser"; readonly packages?: HostPackages };
export type AppWorkerKind<P extends Principal> = {
	readonly kind: KindShape;
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly facet?: string;
	readonly start: (address: Address, context: Context) => Promise<JsonValue> | JsonValue;
	readonly authorize: (principal: P, address: Address) => boolean;
	readonly idleMs?: () => number;
};
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	| { readonly kind: "base_build"; readonly base: string; readonly error: unknown }
	| { readonly kind: "server_scan"; readonly error: unknown };
export type AppLimits = {
	readonly uploads?: number;
	readonly ephemeralSessions?: number;
	readonly pendingPairings?: number;
	readonly pairingsPerAddress?: number;
	readonly importBytes?: number;
	readonly importEntries?: number;
};
export type AppTimeouts = { readonly closeTimeout?: number; readonly readyTimeout?: number; readonly reloadDrainTimeout?: number };
export type AppWeb = Pick<WebSurfaceOptions, "entry" | "conditions"> & Omit<WebRoutesOptions, "routes">;
export type AppOptions<P extends Principal> = {
	readonly name: string;
	readonly dataDir?: string;
	readonly root?: string;
	readonly listen?: ListenAddress;
	readonly api: AppApi;
	readonly kinds: Readonly<Record<string, AppKind>>;
	readonly principal: { readonly server: P; readonly owner: P; readonly worker?: (address: Address) => P };
	readonly workers?: readonly AppWorkerKind<P>[];
	readonly files?: FilesCaps;
	readonly limits?: AppLimits;
	readonly install?: InstallOptions;
	readonly web?: AppWeb;
	readonly tui?: Pick<TuiSurfaceOptions, "entry" | "conditions">;
	readonly telemetry?: TelemetryContext & TelemetryIngestTarget;
	readonly principalAttributes?: PrincipalAttributes<P>;
	readonly base?: readonly string[];
	readonly timeouts?: AppTimeouts;
	readonly onError: (error: AppError) => void;
} & ({ readonly workers?: readonly [] } | { readonly principal: { readonly worker: (address: Address) => P } });
export type AppPlugins = {
	readonly state: Watchable<PluginsState>;
	install(source: PluginSource, context: Context): Promise<readonly string[]>;
	readonly component: Plugins;
};
export interface App<P extends Principal> {
	readonly host: Host<P>;
	readonly http: HttpComponent<P>;
	readonly workers: ReadonlyMap<string, Workers<HostKind>>;
	readonly plugins: AppPlugins;
	readonly web: { readonly base: string | undefined } | undefined;
	readonly tui: { readonly base: string | undefined } | undefined;
	readonly basesBuilt: Promise<void>;
	readonly baseWatched: Promise<void>;
	readonly dataDir: string;
	readonly ownerTokenFile: string;
	ownerLink(): string;
	applyChanges(context: Context): Promise<RolloutResult>;
	exportData(address: Address, path: string, context: Context): Promise<void>;
	importData(archive: string, address: Address, context: Context, options?: DataImportOptions): Promise<void>;
	deleteData(address: Address, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
}
export type DataImportOptions = { readonly existing?: "refuse" | "replace" };
export type KitStart = {
	readonly dir: string;
	readonly facet: string;
	readonly principal: JsonValue;
	readonly server: JsonValue;
	readonly files: { readonly maxFile?: number; readonly maxTotal?: number };
	readonly telemetry: boolean;
	readonly uploads?: number;
	readonly timeouts: AppTimeouts;
};
type ClientSurface<P extends Principal> = {
	readonly name: "web" | "tui";
	readonly surface: WebSurface<P> | TuiSurface<P>;
};
function workerLock(name: string, dir: string, address: Address): string {
	return `${name}:${dir}:${address.key}`;
}
function linkHost(host: string): string {
	return host === "0.0.0.0" || host === ""
		? "127.0.0.1"
		: host === "::"
			? "[::1]"
			: host.includes(":")
				? `[${host}]`
				: host;
}

export async function startServer<P extends Principal>(options: AppOptions<P>, context: Context): Promise<App<P>> {
	if (!isJsonValue(options.principal.owner))
		throw new Error("startServer: principal.owner must be strict JSON (no undefined fields, functions or class instances)");
	if (samePrincipal(options.principal.owner, options.principal.server, context))
		throw new Error("startServer: principal.owner must not be the server's principal");
	const dataDir = await openDataDir(resolve(options.dataDir ?? defaultDataDir(options.name))),
		deadline = AbortSignal.timeout(1000);
	const lock = await processLock(`objects-app:${dataDir}`, withAbortSignal(deadline, context)).catch(
		(error: unknown) => {
			throw deadline.aborted ? new Error(`startServer: another server runs on ${dataDir}`) : error;
		},
	);
	const resources = await (async () => {
		try {
			const layout = await createLayout(dataDir),
				cookieSecret = await secretFile(layout.cookieSecret);
			await privateStore(layout.serverStore);
			return {
				layout,
				cookieSecret,
				store: await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context),
			};
		} catch (error) {
			await lock.release();
			throw error;
		}
	})();
	const { store, layout, cookieSecret } = resources,
		{ api, limits = {}, onError } = options;
	const sessions = createSessions<P>(cookieSecret, { maxEphemeral: limits.ephemeralSessions });
	const host = createHost<P>({
		address: Server(),
		principal: options.principal.server,
		store,
		telemetry: options.telemetry,
		principalAttributes: options.principalAttributes,
		...options.timeouts,
		onError: (error) => onError({ kind: "host", error }),
	});
	const http = createHttp(
		host,
		{
			listen: options.listen ?? { host: "127.0.0.1", port: 0 },
			links: { path: "/objects", opened: sessions.opened },
			telemetry: options.telemetry,
			onError: (error) => onError({ kind: "http", error }),
		},
		context,
	);
	const base = (options.base ?? []).map((path) => resolve(path));
	const plugins = createPlugins(
		{
			roots: [{ path: resolve(options.root ?? "plugins"), required: true }, layout.plugins],
			api: { name: api.name, versions: api.versions },
			install: options.install,
			base,
			publicPath: WEB_PREFIX + "assets/",
			kinds: Object.fromEntries(
				Object.entries(options.kinds).map(([name, kind]) => [
					name,
					{
						platform: kind.platform,
						hostPackages: [
							...api.versions.flatMap((version) => [`${api.name}/${version}`, `${api.name}/${version}/${name}`]),
							...Object.keys(kind.packages ?? {}),
						],
					},
				]),
			),
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	const workers = new Map<string, Workers<HostKind>>(),
		workerHosts = new Map<string, string>();
	function startWorkers(): void {
		const workerPrincipal = options.principal.worker as (address: Address) => P;
		for (const config of options.workers ?? []) {
			const facet = config.facet ?? "worker";
			workers.set(
				config.kind.kind,
				createWorkers(
					host,
					config.kind as HostKind,
					{
						kind: facet,
						entry: config.entry,
						execArgv: config.execArgv,
						env: config.env,
						baseDir: join(layout.workerBases, config.kind.kind),
						compileCache: layout.compileCache,
						authorize: (principal, address) =>
							samePrincipal(principal, options.principal.server, context) || config.authorize(principal, address),
						principal: workerPrincipal,
						start: async (address, ctx) => {
							const principal = workerPrincipal(address);
							workerHosts.set(principalKey(principal, ctx), address.key);
							const kit: KitStart = {
								dir: workerDirectory(dataDir, address),
								facet,
								principal,
								server: options.principal.server as JsonValue,
								files: { ...options.files },
								telemetry: options.telemetry !== undefined,
								timeouts: { ...options.timeouts },
								...(limits.uploads === undefined ? {} : { uploads: limits.uploads }),
							};
							return { kit, app: await config.start(address, ctx) } as unknown as JsonValue;
						},
						lock: (address) => workerLock(options.name, dataDir, address),
						idleMs: config.idleMs,
						plugins,
						onError: (error) => onError({ kind: "workers", error }),
					},
					context,
				),
			);
		}
	}

	const owner = new OwnerLink(),
		surfaces: ClientSurface<P>[] = [];
	const core: PluginFacet<P>[] = [
		{ name: "objects.http", facet: http.facet },
		{ name: "objects.app.info", facet: appInfoFacet({ dataDir, name: options.name, version: api.versions[0] ?? "", owner: options.principal.owner }) },
		{ name: "objects.app.sessions", facet: sessions.facet },
		{ name: "objects.app.owner", facet: ownerFacet(owner, options.principal.owner) },
		{
			name: "objects.app.pairing",
			facet: pairingFacet(new Pairings({ maxPending: limits.pendingPairings, perAddress: limits.pairingsPerAddress }), options.principal.owner),
		},
		{ name: "objects.app.files", facet: filesFacet(join(layout.server, "files"), options.files, limits.uploads) },
		{ name: "objects.themes", facet: themesFacet() },
		{ name: "objects.themes.choice", facet: themeChoiceFacet() },
		{ name: "objects.translations", facet: translationsFacet() },
		{ name: "objects.locale.choice", facet: localeChoiceFacet() },
	];
	if (options.telemetry)
		core.push({
			name: "objects.telemetry",
			facet: telemetryIngestFacet({
				target: options.telemetry,
				workerHost: (principal) => workerHosts.get(principalKey(principal, context)),
				principalAttributes: (principal) => host.principalAttributes(principal, context),
			}),
		});
	let link = "",
		closing: Promise<void> | undefined;
	let building: Promise<void> = Promise.resolve(),
		watching: Promise<void> = Promise.resolve();
	let applying: Promise<void> = Promise.resolve();
	async function addressLock(address: Address, ctx: Context): Promise<ProcessLock | undefined> {
		const timeout = AbortSignal.timeout(2000);
		try {
			return await processLock(workerLock(options.name, dataDir, address), withAbortSignal(timeout, ctx));
		} catch (error) {
			if (timeout.aborted) return undefined;
			throw error;
		}
	}
	async function underLock(address: Address, operation: string, held: string, ctx: Context, work: () => Promise<void>): Promise<void> {
		const lock = await addressLock(address, ctx);
		if (lock === undefined) throw new Error(`${operation}: ${address.key} ${held}`);
		try { await work(); }
		finally { await lock.release(); }
	}
	function pool(address: Address): Workers<HostKind> {
		const pool = workers.get(address.kind);
		if (!pool) throw new Error(`app: no worker kind "${address.kind}"`);
		return pool;
	}
	function surfaceBase(name: "web" | "tui"): { readonly base: string | undefined } | undefined {
		const found = surfaces.find((each) => each.name === name);
		if (!found) return undefined;
		const result = found.surface.built;
		return { base: result?.kind === "built" ? result.base : undefined };
	}
	const app: App<P> = {
		host,
		http,
		workers,
		dataDir,
		ownerTokenFile: layout.ownerToken,
		ownerLink: () => link,
		plugins: {
			state: plugins.state,
			component: plugins,
			install: (source, ctx) => plugins.installPlugin(source, layout.plugins, ctx),
		},
		get web() {
			return surfaceBase("web");
		},
		get tui() {
			return surfaceBase("tui");
		},
		get basesBuilt() {
			return building;
		},
		get baseWatched() {
			return watching;
		},
		applyChanges(ctx) {
			const run = applying.then(async () => {
				const built = await plugins.build(plugins.state.value.dirty, ctx);
				return plugins.rollout(
					[
						plugins.step("server", host),
						...Array.from(workers, ([name, worker]) => worker.step(name)),
						...surfaces.map(({ name, surface }) => surface.step(name)),
					],
					built,
					ctx,
				);
			});
			applying = run.then(
				() => {},
				() => {},
			);
			return run;
		},
		async exportData(address, path, ctx) {
			const worker = pool(address),
				target = resolve(path),
				manifest: ArchiveManifest = {
					format: ARCHIVE_FORMAT,
					app: options.name,
					api: api.versions[0] ?? "",
					address: { kind: address.kind, key: address.key },
				};
			const staging = await mkdtemp(join(dirname(target), ".objects-server-")), server = join(staging, "server.archive");
			try {
				await pipeline(encodeJsonl(host.exportHostData(address, ctx)), createWriteStream(server, { mode: 0o600 }));
			for (let attempt = 1; ; attempt++) {
				if (worker.state.value[address.key]?.status === "running") {
					const data = await host.get(HostData, { address: addressParam(address) }, ctx);
					try {
						await data.exportTo({ path: target, manifest: JSON.stringify(manifest), server }, ctx);
					} finally {
						data.release();
					}
					return;
				}
				const locked = await addressLock(address, ctx);
				if (locked) {
					try {
						await packData(workerDirectory(dataDir, address), manifest, server, target, ctx);
					} finally {
						await locked.release();
					}
					return;
				}
				if (attempt === 5) throw new Error(`exportData: the worker at ${address.key} keeps starting; try again`);
			}
			} finally { await rm(staging, { recursive: true, force: true }); }
		},
		async importData(archive, address, ctx, importOptions = {}) {
			pool(address);
			const dir = workerDirectory(dataDir, address), existing = importOptions.existing ?? "refuse";
			await underLock(address, "importData", "has data (its worker runs)", ctx, async () => {
				if (existing === "refuse" && await exists(dir)) throw new Error(`importData: ${dir} exists already (an address is imported once)`);
				const { staging } = await unpackStaging(
					resolve(archive),
					dirname(dir),
					(manifest) => {
						if (manifest?.format !== ARCHIVE_FORMAT)
							throw new Error(`importData: not a format ${ARCHIVE_FORMAT} archive`);
						if (manifest.app !== options.name)
							throw new Error(`importData: an archive of "${manifest.app}", not "${options.name}"`);
						if (manifest.address?.kind !== address.kind) throw new Error(`importData: an archive of a ${String(manifest.address?.kind)}, not a ${address.kind}`);
					},
					{ bytes: limits.importBytes, entries: limits.importEntries },
					ctx,
				);
				const aside = existing === "replace" && await exists(dir) ? `${dir}.aside-${randomUUID()}` : undefined;
				let placed = false;
				try {
					if (aside !== undefined) await rename(dir, aside);
					await rename(staging, dir);
					placed = true;
					await host.importHostData(decodeJsonl(createReadStream(join(dir, "server.archive"))), ctx, { address, existing });
				} catch (error) {
					if (isObjectsError(error) && error.code === "unavailable" && error.reason === "storage_failed") {
						// Undoing an uncertain commit could pair the old worker directory with newly committed server data.
						throw new Error(`importData: ${address.key}: the server's commit has an unknown outcome; nothing was undone (the new directory is in place${aside === undefined ? "" : `, the old one at ${aside}`}). Run the import again with existing: "replace" once the server's store is back.`, { cause: error });
					}
					await rm(placed ? dir : staging, { recursive: true, force: true });
					if (aside !== undefined && await exists(aside)) await rename(aside, dir);
					throw error;
				}
				await rm(join(dir, "server.archive"), { force: true }).catch(() => {});
				if (aside !== undefined) await rm(aside, { recursive: true, force: true }).catch(() => {});
			});
		},
		async deleteData(address, ctx) {
			pool(address);
			await underLock(address, "deleteData", "runs; stop its worker first", ctx, async () => {
				await host.deleteHostData(address, ctx);
				await rm(workerDirectory(dataDir, address), { recursive: true, force: true });
			});
		},
		close(ctx) {
			return (closing ??= (async () => {
				await http.close(ctx);
				for (const worker of workers.values()) await worker.close(ctx);
				await host.close(ctx);
				await store.close(ctx);
				plugins.close();
				await lock.release();
			})());
		},
	};
	try {
		startWorkers();
		if (options.web) surfaces.push({ name: "web", surface: webSurface(host, { ...options.web, plugins }) });
		if (options.tui) surfaces.push({ name: "tui", surface: tuiSurface(host, { ...options.tui, plugins }) });
		for (const { name, surface } of surfaces) core.push({ name: `objects.${name}`, facet: surface.facet });
		await plugins.load(
			host,
			{ kind: "server", core, modules: { ...api.modules, ...options.kinds.server?.packages } },
			context,
		);
		await ownerTokenFile(layout.ownerToken, options.principal.owner, host, context);
		const token = owner.renew(),
			address = await http.listening(context);
		link = `http://${linkHost(address.host)}:${address.port}${OWNER_PATH}#${token}`;
		const comparisons: Promise<void>[] = [];
		building = Promise.all(
			[
				...surfaces.map(({ name, surface }) => ({ name, build: () => surface.build() })),
				...Array.from(workers, ([name, worker]) => ({ name, build: () => worker.build() })),
			].map(async (base) => {
				const result = await base.build();
				if (closing) return;
				if (result.kind === "built") comparisons.push(plugins.watchBase(result.inputs));
				else onError({ kind: "base_build", base: base.name, error: result.error });
			}),
		).then(() => {});
		watching = (async () => {
			await building;
			if (closing) return;
			const entry = process.argv[1];
			if (entry !== undefined && !entry.split(sep).includes("node_modules")) {
				const inputs = await nodeBaseInputs(entry, processConditions(process.execArgv, process.env.NODE_OPTIONS)).catch(
					(error) => {
						if (!closing) onError({ kind: "server_scan", error });
					},
				);
				if (closing) return;
				if (inputs) comparisons.push(plugins.watchBase(processStartedInputs(inputs)));
			}
			await Promise.all(comparisons);
		})();
	} catch (error) {
		await app.close(context);
		throw error;
	}
	return app;
}

function processStartedInputs(inputs: BaseInputs): BaseInputs {
	const latest = Date.now() + 5000;
	const recorded = new Map(inputs);
	for (const [path] of recorded) {
		try {
			const info = statSync(path);
			if ([info.mtimeMs, info.ctimeMs].some((time) => time > performance.timeOrigin && time <= latest))
				recorded.set(path, "process-start mismatch");
		} catch {}
	}
	return recorded;
}
