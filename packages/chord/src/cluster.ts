import type { Connection } from "./connection.ts";
import { ChordError } from "./errors.ts";
import type { HostImpl, PluginRef } from "./host.ts";
import { beginReload, endReload, type Reload, type ReloadOptions, type ReloadReport, reloadError } from "./reload.ts";
import { type Frame, toWireError } from "./wire.ts";

let sequence = 0;
function modulesFor(entries: ReloadOptions["remote"], name: string | undefined): string[] {
	let best: [string, readonly string[]] | undefined;
	for (const entry of Object.entries(entries ?? {}))
		if (name?.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
	return [...(best?.[1] ?? [])];
}
function awaitVote(connection: Connection, id: number, deadline: number): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new Promise((resolve, reject) => {
		connection.votes.set(id, { resolve, reject });
		timer = setTimeout(() => {
			connection.votes.delete(id);
			reject(new ChordError("aborted", `votes missing after ${deadline} ms`, { reason: "vote_deadline" }));
		}, deadline);
	}).finally(() => clearTimeout(timer));
}
export async function runClusterReload(
	host: HostImpl,
	plugins: readonly PluginRef[],
	options: ReloadOptions,
): Promise<ReloadReport> {
	const synced = [...host.connections].filter(
		(connection) =>
			connection.role === "downstream" && connection.peer.kind === "host" && connection.open && connection.synced,
	);
	const version = host.peekNextCodeVersion(),
		reload = await beginReload(host, plugins, options, version);
	try {
		await reload.waitForRetirement();
		const participants = synced.filter((connection) => connection.open),
			id = ++sequence;
		const deadline = options.voteDeadline ?? (options.gateDeadline ?? 5000) + (options.retireDeadline ?? 5000) + 5000;
		const votes = participants.map((connection) => {
			const name = connection.name ?? "child",
				vote = awaitVote(connection, id, deadline);
			connection.send({
				t: "prepare",
				reload: id,
				codeVersion: version,
				plugins: modulesFor(options.remote, name),
				options: {
					remove: modulesFor(options.remoteRemove, name),
					gateDeadline: options.gateDeadline,
					retireDeadline: options.retireDeadline,
				},
			});
			return vote.then(
				(report) => [name, report as ReloadReport | undefined] as const,
				(error) => {
					const cause = reloadError(error);
					throw new ChordError(cause.code, `${name}: ${cause.message}`, { cause, reason: cause.reason });
				},
			);
		});
		let local = false;
		const results = await Promise.allSettled([
			reload.prepare().then(() => {
				local = true;
			}),
			...votes,
		]);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) {
			for (const connection of participants) {
				connection.votes.delete(id);
				connection.send({ t: "abort", reload: id });
			}
			if (local) await reload.rollback();
			throw failure.reason;
		}
		const report = reload.commit(() => {
			for (const connection of participants) {
				connection.send({ t: "commit", reload: id });
				connection.peerCodeVersion = version;
			}
		});
		host.rememberRemoteModules(options.remote, options.remoteRemove);
		const children: Record<string, ReloadReport> = {};
		for (const result of results.slice(1))
			if (result.status === "fulfilled") {
				const [name, child] = result.value as readonly [string, ReloadReport | undefined];
				if (child) children[name] = child;
			}
		return { ...report, children };
	} finally {
		endReload(host);
	}
}
export async function reconcileChild(host: HostImpl, connection: Connection): Promise<void> {
	while (connection.open) {
		if (host.reloading) {
			await host.whenReloadEnded();
			continue;
		}
		const version = host.current.id;
		if (connection.peerCodeVersion === version) {
			connection.markSynced(version);
			host.announceRetired(connection);
			return;
		}
		host.announceRetired(connection);
		const id = ++sequence,
			vote = awaitVote(connection, id, 30000);
		connection.send({
			t: "prepare",
			reload: id,
			codeVersion: version,
			plugins: modulesFor(host.remoteModules, connection.name),
			options: { remove: modulesFor(host.remoteRemoved, connection.name) },
		});
		await vote;
		if (host.current.id !== version) {
			connection.send({ t: "abort", reload: id });
			continue;
		}
		connection.send({ t: "commit", reload: id });
		connection.peerCodeVersion = version;
	}
}
interface Operation {
	id: number;
	reload: Reload | undefined;
	state: "loading" | "preparing" | "prepared";
	cancelled: boolean;
}
export class ChildReloads {
	readonly #host: HostImpl;
	#operation: Operation | undefined;
	constructor(host: HostImpl) {
		this.#host = host;
	}
	handle(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		if (frame.t === "prepare") {
			if (this.#operation) {
				connection.send({
					t: "vote",
					reload: frame.reload,
					error: toWireError(
						new ChordError("unavailable", "a reload is already running", { reason: "reload_running" }),
					),
				});
				return;
			}
			const operation: Operation = { id: frame.reload, reload: undefined, state: "loading", cancelled: false };
			this.#operation = operation;
			void this.#run(operation, connection, frame).catch((error) => this.#host.report(error));
			return;
		}
		const operation = this.#operation;
		if (!operation || operation.id !== frame.reload) return;
		if (frame.t === "abort") {
			this.#cancel(operation);
			return;
		}
		if (operation.state !== "prepared") return;
		this.#operation = undefined;
		try {
			operation.reload?.commit();
		} finally {
			endReload(this.#host);
		}
	}
	parentLost(): void {
		if (this.#operation) this.#cancel(this.#operation);
	}
	#cancel(operation: Operation): void {
		operation.cancelled = true;
		if (operation.state !== "prepared") {
			void operation.reload?.rollback().catch((error) => this.#host.report(error));
			return;
		}
		this.#operation = undefined;
		void operation.reload
			?.rollback()
			.catch((error) => this.#host.report(error))
			.finally(() => endReload(this.#host));
	}
	async #run(operation: Operation, connection: Connection, frame: Extract<Frame, { t: "prepare" }>): Promise<void> {
		const check = (): void => {
			if (operation.cancelled) throw new ChordError("aborted", "reload aborted by the server", { reason: "aborted" });
		};
		try {
			operation.reload = await beginReload(this.#host, frame.plugins, frame.options, frame.codeVersion);
			check();
			operation.state = "preparing";
			await operation.reload.prepare();
			check();
			operation.state = "prepared";
			connection.send({ t: "vote", reload: frame.reload, report: operation.reload.summary() });
		} catch (error) {
			if (operation.reload) {
				await operation.reload.rollback().catch((cleanup) => this.#host.report(cleanup));
				endReload(this.#host);
			}
			if (this.#operation === operation) this.#operation = undefined;
			if (!operation.cancelled) connection.send({ t: "vote", reload: frame.reload, error: toWireError(error) });
		}
	}
}
