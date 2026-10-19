import type { Cell } from "./cell.ts";
import { type AnyContract, bind, coverage } from "./contract.ts";
import { asChordError, ChordError, invalid, isChordError } from "./errors.ts";
import type { Facet, HostImpl, PluginRef, Serve } from "./host.ts";
import {
	type Factory,
	hostLifetime,
	makeService,
	memberSchemas,
	type ObjectImpl,
	RefImpl,
	type ResourceImpl,
	type Run,
	type ServeOptions,
	type Service,
	type StagedListeners,
} from "./object.ts";
import { holdPublications } from "./publish.ts";
import type { RegistryTable } from "./registry.ts";
import { assertValid, deepEqual } from "./schema.ts";
import type { Readable } from "./types.ts";

export interface ReloadOptions {
	readonly remove?: readonly string[];
	readonly gateDeadline?: number;
	readonly retireDeadline?: number;
	readonly remote?: Readonly<Record<string, readonly string[]>>;
	readonly remoteRemove?: Readonly<Record<string, readonly string[]>>;
	readonly voteDeadline?: number;
}
export interface ReloadReport {
	readonly codeVersion: number;
	readonly previous: number;
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	readonly prepared: readonly string[];
	readonly gated: readonly string[];
	readonly children?: Readonly<Record<string, ReloadReport>>;
}
interface Candidate {
	object: ObjectImpl;
	service: Service;
	run: Run;
	reasons: string[];
	atGate: ResourceImpl[];
	replaced: ResourceImpl[];
	migrated: Map<Cell<unknown>, unknown>;
	derived: Map<unknown, unknown>;
	staged: StagedListeners | undefined;
}
function candidateValue(source: Readable<unknown>): unknown {
	try {
		return source.value;
	} catch (error) {
		if (isChordError(error, "not_ready") || isChordError(error, "not_in_variant")) return undefined;
		throw error;
	}
}
function dryRun(candidate: Candidate): void {
	const exposed = memberSchemas(candidate.service, candidate.run.implementation);
	for (const [cell, value] of candidate.migrated)
		for (const schema of exposed.get(cell) ?? [])
			assertValid("state", `${candidate.object.address}: migrated state ${cell.key}`, schema, value);
	const values = new Map<unknown, unknown>(candidate.migrated);
	for (const [name, derived] of [...candidate.run.decls.derives].sort(([, a], [, b]) => a.seq - b.seq)) {
		const value = derived.compute((source) => (values.has(source) ? values.get(source) : candidateValue(source)));
		for (const schema of exposed.get(derived) ?? [])
			assertValid("state", `${candidate.object.address}: derivation ${name}`, schema, value);
		values.set(derived, value);
	}
	candidate.derived = values;
}
export function reloadError(error: unknown): ChordError {
	const cause = asChordError(error, "reload");
	return /^reload aborted/.test(cause.message.replace(/^[^:]*: /, ""))
		? cause
		: new ChordError(cause.code, `reload aborted: ${cause.message}`, {
				cause,
				reason: cause.reason,
				details: cause.details,
			});
}
export async function beginReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
	codeVersion?: number,
): Promise<Reload> {
	if (host.reloading) throw new ChordError("unavailable", "a reload is already running", { reason: "reload_running" });
	host.reloading = true;
	try {
		return new Reload(host, await host.resolve(plugins), options, codeVersion);
	} catch (error) {
		host.reloadEnded();
		throw reloadError(error);
	}
}
export function endReload(host: HostImpl): void {
	host.reloadEnded();
}
export async function runReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	const reload = await beginReload(host, plugins, options);
	try {
		await reload.prepare();
		return reload.commit();
	} finally {
		endReload(host);
	}
}
function until(host: HostImpl, ready: () => boolean, ms: number): Promise<boolean> {
	if (ready()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			stop();
			resolve(false);
		}, ms);
		const stop = host.watchRetirement(() => {
			if (ready()) {
				clearTimeout(timer);
				stop();
				resolve(true);
			}
		});
	});
}

export class Reload {
	readonly host: HostImpl;
	readonly facets: readonly Facet[];
	readonly options: ReloadOptions;
	readonly codeVersion: number | undefined;
	readonly candidates = new Map<ObjectImpl, Candidate>();
	readonly abort = new AbortController();
	readonly closed: [ObjectImpl, ResourceImpl][] = [];
	services = new Map<string, Service>();
	changed = new Set<string>();
	removed = new Set<string>();
	tables = new Map<string, RegistryTable<unknown>>();
	gated: Candidate[] = [];
	rolledBack = false;
	readonly deferred = new Map<ObjectImpl, StagedListeners>();
	readonly facetRuns = new Map<string, AbortController>();
	readonly #starts: (() => void)[] = [];
	constructor(host: HostImpl, facets: readonly Facet[], options: ReloadOptions, codeVersion?: number) {
		this.host = host;
		this.facets = facets;
		this.options = options;
		this.codeVersion = codeVersion;
	}
	#alive(): void {
		if (this.rolledBack) throw new ChordError("aborted", "reload aborted while preparing", { reason: "aborted" });
	}
	async prepare(): Promise<void> {
		try {
			await this.waitForRetirement();
			this.load();
			this.checkProviders();
			await this.prepareAll();
			this.host.gating = this.changed;
			await this.withDeadline(this.prepareAll(), "activations in flight did not finish");
			this.checkRefs();
			this.tables = this.host.buildTables(this.entries());
			await this.gate();
			this.#alive();
			for (const candidate of this.candidates.values())
				if (candidate.object.status === "live") candidate.staged = candidate.object.stageListeners(candidate.run.decls);
			for (const object of this.host.objects.values())
				if (object.status === "live" && object.deferredRuntime)
					this.deferred.set(object, object.stageListeners(object.decls));
		} catch (error) {
			await this.rollback();
			throw reloadError(error);
		}
	}
	summary(): ReloadReport {
		return {
			codeVersion: this.host.pending?.id ?? this.host.current.id,
			previous: this.host.current.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared: [...this.candidates.values()]
				.filter((candidate) => candidate.object.status === "live")
				.map((candidate) => candidate.object.address),
			gated: this.gated.map((candidate) => candidate.object.address),
		};
	}
	async waitForRetirement(): Promise<void> {
		const previous = this.host.previous;
		if (!previous) return;
		const deadline = this.options.retireDeadline ?? 5000,
			gone = (): boolean => this.host.previous !== previous;
		if (!(await until(this.host, () => gone() || this.host.retirable(), deadline)) && !gone()) {
			previous.abort.abort(new ChordError("superseded", `code version ${previous.id} was retired`));
			await until(this.host, () => gone() || !previous.roots.size, Math.min(deadline, 1000));
		}
		if (!gone()) this.host.retire();
	}
	load(): void {
		const replaced = new Set([...this.facets.map((facet) => facet.name), ...(this.options.remove ?? [])]);
		const current = this.host.current.services;
		this.services = new Map([...current].filter(([, service]) => !replaced.has(service.facet)));
		for (const facet of this.facets) {
			const run = new AbortController();
			this.facetRuns.set(facet.name, run);
			facet.setup(
				this.host.facetApi(
					((type: AnyContract, factory: Factory<AnyContract>, options: ServeOptions = {}) => {
						this.host.serveInto(this.services, makeService(type, factory, options, facet.name));
					}) as Serve,
					run.signal,
				),
			);
		}
		for (const [name, service] of this.services) if (current.get(name) !== service) this.changed.add(name);
		for (const name of current.keys()) if (!this.services.has(name)) this.removed.add(name);
		this.host.pending = {
			id: this.host.nextCodeVersionId(this.codeVersion),
			services: this.services,
			tables: new Map(),
			roots: new Map(),
			abort: new AbortController(),
		};
	}
	async withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new ChordError("aborted", `${what} within ${deadline} ms`, { reason: "deadline" })),
				deadline,
			);
		});
		try {
			return await Promise.race([promise, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
	checkProviders(): void {
		for (const name of this.changed) {
			const next = this.services.get(name)!.contract,
				old = this.host.current.services.get(name)?.contract;
			if (!old || old.version !== next.version) continue;
			const reason = coverage(next.description, old.description);
			if (reason !== undefined)
				throw new ChordError(
					"contract_mismatch",
					`${name}@${next.version} changed incompatibly without a version bump (${reason})`,
				);
		}
		const facets = new Map(this.host.facets);
		for (const facet of this.facets) facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) facets.delete(name);
		for (const facet of facets.values())
			for (const token of facet.uses ?? []) {
				const service = this.services.get(token.name);
				if (service && this.changed.has(token.name)) bind(service.contract, service.options.accepts, token);
			}
	}
	async prepareAll(): Promise<void> {
		while (true) {
			const todo = [...this.host.objects.values()].filter(
				(object) =>
					this.changed.has(object.typeName) &&
					!this.candidates.has(object) &&
					object.service !== this.services.get(object.typeName) &&
					(object.status === "live" || object.status === "activating"),
			);
			if (!todo.length) return;
			await Promise.allSettled(todo.map((object) => object.ready));
			this.#alive();
			for (const object of todo)
				if (object.status === "live" && object.service !== this.services.get(object.typeName)) {
					await this.prepareObject(object);
					this.#alive();
				}
		}
	}
	async prepareObject(object: ObjectImpl): Promise<void> {
		const service = this.services.get(object.typeName)!,
			run = object.run(service, object.decls);
		const candidate: Candidate = {
			object,
			service,
			run,
			reasons: [],
			atGate: [],
			replaced: [],
			migrated: new Map(),
			derived: new Map(),
			staged: undefined,
		};
		this.candidates.set(object, candidate);
		for (const [name, cell] of run.decls.cells) {
			if (object.decls.cells.get(name) !== cell) continue;
			const from = object.decls.cellVersions.get(name) ?? 1,
				to = run.decls.cellVersions.get(name) ?? 1;
			if (to < from)
				throw invalid("state", `${object.address}: version of state ${name} lowered from ${from} to ${to}`);
			if (to > from) candidate.reasons.push(`state ${name} version ${from} -> ${to}`);
			else if (!deepEqual(cell.schema, run.decls.cellSchemas.get(name)))
				throw invalid("state", `${object.address}: schema of state ${name} changed without a version bump`);
		}
		const deferred = new Set<ResourceImpl>();
		for (const resource of run.created.resources)
			if (resource.exclusive || resource.deps.some((dep) => deferred.has(dep as ResourceImpl))) deferred.add(resource);
		for (const resource of deferred) {
			candidate.atGate.push(resource);
			const old = object.decls.resources.get(resource.key);
			if (resource.exclusive && old?.exclusive && old.state === "open") candidate.replaced.push(old);
		}
		if (deferred.size) candidate.reasons.push("exclusive resource replaced");
		await object.open(
			run.created.resources.filter((resource) => !deferred.has(resource)),
			run.created.refs,
			this.abort.signal,
		);
		await object.waitHydrated(run);
		if (!candidate.reasons.length) {
			await object.initCells(run, this.abort.signal);
			dryRun(candidate);
		}
	}
	checkRefs(): void {
		const dropped = new Set<unknown>();
		for (const { object, run } of this.candidates.values())
			for (const ref of object.decls.refs.values()) if (![...run.decls.refs.values()].includes(ref)) dropped.add(ref);
		for (const object of this.host.objects.values()) {
			const service = this.services.get(object.typeName);
			if (!service || !this.changed.has(object.typeName)) continue;
			for (const ref of object.refs)
				if (ref !== this.host.hostObjects.get(object.typeName) && !dropped.has(ref) && ref.owner !== "client")
					bind(service.contract, service.options.accepts, ref.contract);
		}
	}
	entries(): [ObjectImpl, Run["decls"]][] {
		return this.host
			.liveDecls(true)
			.filter(([object]) => !this.removed.has(object.typeName))
			.map(([object, decls]) => [object, this.candidates.get(object)?.run.decls ?? decls]);
	}
	async gate(): Promise<void> {
		this.gated = [...this.candidates.values()].filter(
			(candidate) => candidate.reasons.length && candidate.object.status === "live",
		);
		const drained = this.gated.map(
			({ object }) =>
				new Promise<void>((resolve) => {
					const grandfathered = new Set(object.leases.keys());
					object.gate = { grandfathered, queue: [], drained: resolve };
					object.stopTasks();
					if (!grandfathered.size) resolve();
				}),
		);
		const deadline = this.options.gateDeadline ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			Promise.all(drained).then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), deadline);
			}),
		]);
		clearTimeout(timer);
		if (timedOut) {
			const blocking = this.gated.flatMap(({ object }) => [...(object.gate?.grandfathered ?? [])]);
			throw new ChordError("aborted", `gate deadline (${deadline} ms) missed; blocking roots: ${blocking.join(", ")}`, {
				reason: "gate_deadline",
				details: { blocking },
			});
		}
		this.#alive();
		for (const candidate of this.gated) {
			for (const old of candidate.replaced) {
				this.closed.push([candidate.object, old]);
				await old.close(candidate.object.openOrder);
			}
			await candidate.object.open(candidate.atGate, [], this.abort.signal);
			this.#alive();
			await candidate.object.initCells(candidate.run, this.abort.signal);
			this.#alive();
		}
		for (const candidate of this.gated) this.migrate(candidate);
	}
	migrate(candidate: Candidate): void {
		for (const [name, cell] of candidate.run.decls.cells) {
			const old = candidate.object.decls;
			if (old.cells.get(name) !== cell) continue;
			const schema = candidate.run.decls.cellSchemas.get(name)!,
				from = old.cellVersions.get(name) ?? 1,
				fn = candidate.run.decls.cellMigrations.get(name);
			let value: unknown;
			if ((candidate.run.decls.cellVersions.get(name) ?? 1) > from && fn) value = fn(structuredClone(cell.value), from);
			else if (!deepEqual(cell.schema, schema)) value = cell.value;
			else continue;
			assertValid("state", `${candidate.object.address}: migrated state ${name}`, schema, value);
			candidate.migrated.set(cell, value);
		}
		dryRun(candidate);
	}
	async rollback(): Promise<void> {
		if (this.rolledBack) return;
		this.rolledBack = true;
		this.abort.abort(new ChordError("aborted", "reload aborted"));
		for (const run of this.facetRuns.values()) run.abort(new ChordError("aborted", "reload aborted"));
		const report = (error: unknown): void => this.host.report(error);
		for (const candidate of this.candidates.values()) candidate.staged?.discard();
		for (const staged of this.deferred.values()) staged.discard();
		for (const { object, run } of this.candidates.values()) {
			object.pending.delete(run.decls);
			await object.unwind(run).catch(report);
		}
		for (const [object, resource] of this.closed)
			if (resource.state === "closed")
				await resource.open(new AbortController().signal, object.openOrder).catch((error) => {
					resource.markUnavailable();
					report(
						new ChordError("unavailable", `${object.address}: resource ${resource.key} could not be restored`, {
							cause: error,
						}),
					);
				});
		for (const { object } of this.gated)
			if (object.gate) {
				object.openGate();
				object.startTasks();
			}
		const reason = new ChordError("gone", "reload aborted; type not served");
		for (const object of [...this.host.objects.values()])
			if (!this.host.current.services.has(object.typeName)) await object.dispose(true, reason).catch(report);
		this.host.pending = undefined;
		this.host.gating = undefined;
	}
	commit(beforeStart?: () => void): ReloadReport {
		try {
			return holdPublications(() => {
				const report = this.#publish();
				beforeStart?.();
				for (const start of this.#starts.splice(0)) start();
				return report;
			});
		} catch (error) {
			this.host.fail(error);
			throw reloadError(error);
		}
	}
	#publish(): ReloadReport {
		const host = this.host,
			previous = host.current,
			next = host.pending!;
		host.pending = undefined;
		host.codeVersions.set(next.id, next);
		host.previous = previous;
		host.current = next;
		const prepared: string[] = [];
		for (const object of [...host.objects.values()]) {
			if (this.removed.has(object.typeName)) continue;
			const candidate = this.candidates.get(object);
			if (!candidate) {
				const installed = object.implementations.get(previous.id);
				if (installed) object.implementations.set(next.id, { ...installed, codeVersion: next.id });
			} else if (object.status === "live") {
				this.install(candidate, next.id);
				prepared.push(object.address);
			}
		}
		for (const { object, run, staged } of this.candidates.values())
			if (object.status !== "live") {
				staged?.discard();
				object.pending.delete(run.decls);
				void object.unwind(run).catch((error) => host.report(error));
			}
		for (const [object, staged] of this.deferred) {
			if (object.status !== "live") {
				staged.discard();
				continue;
			}
			object.deferredRuntime = false;
			staged.activate();
			this.#starts.push(() => object.startTasks());
		}
		host.installTables(next, this.tables, true);
		const reason = new ChordError("gone", "type no longer served");
		for (const object of [...host.objects.values()])
			if (this.removed.has(object.typeName)) void object.dispose(true, reason).catch((error) => host.report(error));
		for (const name of this.removed) host.hostObjects.delete(name);
		for (const facet of this.facets) host.facets.set(facet.name, facet);
		for (const name of this.options.remove ?? []) host.facets.delete(name);
		for (const [name, run] of this.facetRuns) this.#starts.push(() => host.facetRunChanged(name, run));
		for (const name of this.options.remove ?? []) this.#starts.push(() => host.facetRunChanged(name, undefined));
		host.gating = undefined;
		for (const [name, service] of this.services) {
			if (hostLifetime(service) && this.changed.has(name) && host.hostObjects.get(name)?.object?.status !== "live")
				this.#starts.push(() => host.startHostObject(service));
			const pinned = host.hostObjects.get(name);
			if (!hostLifetime(service) && pinned) {
				host.hostObjects.delete(name);
				this.#starts.push(() => pinned.release());
			}
		}
		return {
			codeVersion: next.id,
			previous: previous.id,
			changed: [...this.changed],
			removed: [...this.removed],
			prepared,
			gated: this.gated.map((candidate) => candidate.object.address),
		};
	}
	install(candidate: Candidate, version: number): void {
		const { object, run, service } = candidate,
			gated = candidate.reasons.length > 0;
		object.pending.delete(run.decls);
		object.stopTasks();
		if (gated) {
			const kept = new Set(run.decls.derives.values());
			for (const derived of object.decls.derives.values()) if (!kept.has(derived)) derived.detach();
		}
		object.decls = run.decls;
		object.service = service;
		for (const [resource, declaration] of run.decls.adopted) resource.adopt(declaration);
		object.implementations.set(version, {
			codeVersion: version,
			service,
			implementation: run.implementation,
			decls: run.decls,
		});
		if (gated) {
			object.minCodeVersion = version;
			for (const old of [...object.implementations.keys()])
				if (old !== version) this.host.retireImplementation(object, old);
		}
		object.refreshSchemas();
		for (const [name, cell] of run.decls.cells) {
			const schema = run.decls.cellSchemas.get(name)!;
			if (candidate.migrated.has(cell)) cell.reset(candidate.migrated.get(cell), schema);
			else cell.schema = schema;
		}
		const created = new Set(run.created.derives);
		for (const derived of run.created.derives) derived.attach(candidate.derived);
		for (const derived of run.decls.derives.values()) if (!created.has(derived)) derived.refresh();
		candidate.staged?.activate();
		this.#starts.push(() => object.startTasks());
		object.openGate();
		const pinned = this.host.hostObjects.get(object.typeName);
		if (pinned?.object === object && pinned.contract.fingerprint !== service.contract.fingerprint) {
			const replacement = new RefImpl(object, service.contract, "host");
			object.addRef(replacement);
			this.host.hostObjects.set(object.typeName, replacement);
			pinned.release();
		}
		for (const ref of [...object.refs]) {
			if (ref.owner === "client") {
				try {
					bind(service.contract, service.options.accepts, ref.contract);
				} catch (error) {
					ref.gone(
						new ChordError("upgrade_required", `${object.typeName} changed; reload the web facets`, { cause: error }),
					);
					object.release(ref);
					continue;
				}
			}
			ref.shapeChanged();
		}
	}
}
