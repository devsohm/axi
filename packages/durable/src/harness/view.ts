import { type AttachedReplicatedState, type Context, type JsonValue, replicatedState } from "@axi/chord";
import { withoutAbortSignal } from "@axi/chord/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@axi/chord/delta";
import { CommittedStateSource, CommittedWatch } from "../session/observation.ts";
import { contained, type SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	DocumentId,
	EntryRecord,
	JsonObject,
	Storage,
	WatchHandle,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { activeEntries, captureContextBounds } from "./context.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

export type ConversationView = {
	readonly conversation: ConversationRecord;
	readonly entries: readonly EntryRecord[];
	readonly docs: Readonly<Record<string, JsonObject>>;
};
export type ViewObserver = {
	advance?(value: ConversationView, ops: readonly Op[], context: Context): void;
	publication?(
		before: ConversationView,
		after: ConversationView,
		ops: readonly Op[],
		publication: CommitPublication,
		context: Context,
	): void;
	closeSession(failure: { readonly error: unknown } | undefined): void;
};
type Mount = {
	value: ConversationView;
	readonly docs: Map<string, { id: DocumentId; version: number }>;
	readonly observers: Set<ViewObserver>;
};
const mounted = [
	AgentDoc,
	LiveDoc,
	InboxDoc,
	ProviderDoc,
	UsageDoc,
] as unknown as readonly ConversationDocToken<JsonObject>[];
const mountedKinds = new Set(mounted.map((token) => token.definition.kind));
const hosts = new WeakMap<object, ConversationViews>();
export function conversationViews(harness: object): ConversationViews {
	const views = hosts.get(harness);
	if (views === undefined) throw new Error("Not a Harness");
	return views;
}

export class ConversationViews {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;
	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		hosts.set(session, this);
		session.observeCommits((publication, context) => {
			for (const [id, mount] of this.#mounts) advance(id, mount, publication, context, (error) => this.report(error));
		});
		session.subscribeClose(() => {
			this.#closed = true;
			for (const mount of this.#mounts.values())
				for (const observer of [...mount.observers])
					contained(
						() => observer.closeSession(session.failure),
						(error) => this.report(error),
					);
			this.#mounts.clear();
		});
	}
	report(error: unknown): void {
		this.#session.report(error);
	}
	async state(id: ConversationId, context: Context): Promise<AttachedReplicatedState<ConversationView>> {
		const { observer, detach } = await this.attach(
			id,
			(value, release) => new CommittedStateSource<ConversationView>(value, release),
			context,
		);
		try {
			return replicatedState(observer, { onError: (error) => this.report(error) });
		} catch (error) {
			detach();
			throw error;
		}
	}
	async watch(id: ConversationId, context: Context): Promise<WatchHandle<ConversationView>> {
		const { observer } = await this.attach(
			id,
			(value, release) => new CommittedWatch<ConversationView>(value, release, (error) => this.report(error)),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.cancel();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeCancellation(signal);
		return observer;
	}
	attach<O extends ViewObserver>(
		id: ConversationId,
		create: (value: ConversationView, release: () => void, storage: Storage) => O | Promise<O>,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mounts.get(id) ?? (await this.#build(id, context));
			const detach = () => {
				mount.observers.delete(observer);
				if (!mount.observers.size && this.#mounts.get(id) === mount) this.#mounts.delete(id);
			};
			const observer = await create(mount.value, detach, this.#storage);
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			this.#mounts.set(id, mount);
			mount.observers.add(observer);
			return { observer, detach };
		});
	}
	async #build(id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await this.#storage.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const bounds = await captureContextBounds(this.#storage, id, context),
			entries = await activeEntries(this.#storage, id, bounds, context),
			docs: Record<string, JsonObject> = {},
			incarnations = new Map<string, { id: DocumentId; version: number }>();
		for (const token of mounted) {
			const document = await this.#session.conversationDocumentOnLine(token, id, context);
			if (document === undefined) continue;
			docs[token.definition.kind] = document.value;
			incarnations.set(token.definition.kind, { id: document.record.id, version: document.version });
		}
		return { value: { conversation, entries, docs }, docs: incarnations, observers: new Set() };
	}
}
function advance(
	id: ConversationId,
	mount: Mount,
	publication: CommitPublication,
	context: Context,
	report: (error: unknown) => void,
): void {
	const documentOps: Op[] = [],
		entryOps: Op[] = [];
	let entries = mount.value.entries;
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === id) {
			const entry = change.value,
				value = entry as unknown as JsonValue;
			if (entry.head === undefined) {
				entryOps.push(["p", ["entries"], entries.length, 0, [value]]);
				entries = [...entries, entry];
			} else {
				let from = entries.findIndex((item) => item.head === undefined && item.id >= entry.head!);
				if (from < 0) from = entries.length;
				entryOps.push(["p", ["entries"], 0, from, [value]]);
				entries = [entry, ...entries.slice(from)];
			}
			continue;
		}
		if (
			change.type !== "document" ||
			change.conversationId !== id ||
			!mountedKinds.has(change.record.kind) ||
			change.record.key !== undefined
		)
			continue;
		const kind = change.record.kind,
			path: NonEmptyPath = ["docs", kind],
			previous = mount.docs.get(kind);
		if (change.value === null) {
			if (previous?.id !== change.record.id) continue;
			mount.docs.delete(kind);
			documentOps.push(["d", path]);
		} else if (previous?.id === change.record.id && previous.version === change.version)
			for (const op of change.ops) documentOps.push(prefixed(op, path));
		else {
			mount.docs.set(kind, { id: change.record.id, version: change.version! });
			documentOps.push(["s", path, change.value]);
		}
	}
	const before = mount.value,
		ops = [...documentOps, ...entryOps],
		frame = withoutAbortSignal(context);
	if (ops.length) {
		const value = documentOps.length ? applyImmutable(mount.value, documentOps) : mount.value;
		mount.value = entries === value.entries ? value : { ...value, entries };
		for (const observer of [...mount.observers]) contained(() => observer.advance?.(mount.value, ops, frame), report);
	}
	for (const observer of [...mount.observers])
		contained(() => observer.publication?.(before, mount.value, ops, publication, frame), report);
}
function prefixed(op: Op, prefix: NonEmptyPath): Op {
	const path = (suffix: Path): NonEmptyPath => [...prefix, ...suffix] as unknown as NonEmptyPath;
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "p":
			return ["p", path(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", path(op[1]), op[2]];
		case "s":
			return ["s", path(op[1]), op[2]];
		case "d":
			return ["d", path(op[1])];
		case "a":
			return ["a", path(op[1]), op[2]];
		case "t":
			return ["t", path(op[1]), op[2]];
	}
}
