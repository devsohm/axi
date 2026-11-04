import { type Context } from "@axi/objects/context";
import { type JsonValue } from "@axi/objects/json";
import { Watch, type WatchCall, type WatchEnd } from "@axi/objects/watch";
import { withoutAbortSignal } from "@axi/objects/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@axi/objects/delta";
import { contained, NORMAL_END, sessionObserverEnd, type ObservedCommit, type SessionImpl } from "../session/session.ts";
import { GuardedObserver } from "../session/observer.ts";
import { idFromNumber } from "../ids.ts";
import type {
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	Cursor,
	DocumentId,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Observation,
	Observer,
	Storage,
	WatchHandle,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

export type ConversationView = {
	readonly conversation: ConversationRecord;
	readonly entries: readonly EntryRecord[];
	readonly before?: EntryId;
	readonly docs: Readonly<Record<string, JsonObject>>;
};
export type ConversationWindow = { readonly from?: EntryId; readonly min?: number; readonly max?: number };
export type ViewObserver = {
	advance(call: WatchCall<ConversationView>, context: Context): void;
	end(end: WatchEnd): void;
};
type Windowed = { value: ConversationView; min: number; max: number; observer: ViewObserver };
type Mount = {
	conversation: ConversationRecord;
	values: ConversationView["docs"];
	docs: Map<string, { id: DocumentId; version: number }>;
	observers: Set<Windowed>;
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
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;
	constructor(session: SessionImpl) {
		this.#session = session;
		hosts.set(session, this);
		session.followCommits((publication, context) => {
			for (const [id, mount] of this.#mounts) advance(id, mount, publication, context, (error) => this.report(error));
		});
		session.subscribeClose(() => {
			this.#closed = true;
			const observerEnd = sessionObserverEnd(session.failure);
			const watchEnd = session.failure === undefined ? NORMAL_END : observerEnd;
			for (const mount of this.#mounts.values())
				for (const { observer } of [...mount.observers])
					contained(
						() => observer.end(observer instanceof Watch ? watchEnd : observerEnd),
						(error) => this.report(error),
					);
			this.#mounts.clear();
		});
	}
	report(error: unknown): void {
		this.#session.report(error);
	}
	async observe(
		id: ConversationId,
		target: Observer<ConversationView>,
		context: Context,
		window?: ConversationWindow,
	): Promise<Observation<ConversationView>> {
		let value!: ConversationView;
		const { observer, detach } = await this.attach(
			id,
			window,
			(current, release) => {
				value = current;
				return new GuardedObserver(target, release, (error) => this.report(error));
			},
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			detach();
			throw signal.reason;
		}
		return observedValue(value, observer);
	}
	async watch(
		id: ConversationId,
		context: Context,
		window?: ConversationWindow,
	): Promise<WatchHandle<ConversationView>> {
		const { observer } = await this.attach(
			id,
			window,
			(value, release) => new Watch(value, release, (error) => this.report(error)),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.abort();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeAbort(signal);
		return observer;
	}
	attach<O extends ViewObserver>(
		id: ConversationId,
		window: ConversationWindow | undefined,
		create: (value: ConversationView, detach: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach(): void }> {
		const min = window?.min ?? 50;
		const max = window?.max ?? 2 * min;
		const from = window?.from;
		if (!Number.isSafeInteger(min) || min < 1) throw new RangeError(`Window min must be an integer >= 1, got ${min}`);
		if (!Number.isSafeInteger(max) || max < min)
			throw new RangeError(`Window max must be an integer >= min (${min}), got ${max}`);
		if (from !== undefined && !Number.isSafeInteger(from))
			throw new RangeError(`Window from must be an entry ID, got ${from}`);
		return this.#session.readOnLine(async (storage) => {
			const mount = this.#mounts.get(id) ?? (await this.#build(storage, id, context));
			const entries = await this.#window(storage, id, from, min, max, context);
			const value: ConversationView = { conversation: mount.conversation, ...entries, docs: mount.values };
			let subscription: Windowed | undefined;
			const detach = () => {
				if (subscription !== undefined) mount.observers.delete(subscription);
				if (mount.observers.size === 0 && this.#mounts.get(id) === mount) this.#mounts.delete(id);
			};
			const observer = create(value, detach);
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			subscription = { min, max, value, observer };
			mount.observers.add(subscription);
			this.#mounts.set(id, mount);
			return { observer, detach };
		});
	}
	async #window(
		storage: Storage,
		id: ConversationId,
		from: EntryId | undefined,
		min: number,
		max: number,
		context: Context,
	): Promise<Pick<ConversationView, "entries" | "before">> {
		if (from !== undefined) {
			const entries = await this.#scan(
				storage,
				{ conversationId: id, minEntryId: from, order: "ascending" },
				max + 1,
				context,
			);
			if (entries.length <= max) {
				const previous = await this.#scan(
					storage,
					{ conversationId: id, maxEntryId: idFromNumber<EntryId>(from - 1) },
					1,
					context,
				);
				return previous.length ? { entries, before: previous[0]!.id } : { entries };
			}
		}
		const entries = await this.#scan(storage, { conversationId: id }, min + 1, context);
		const before = entries.length > min ? entries.pop()!.id : undefined;
		entries.reverse();
		return before === undefined ? { entries } : { entries, before };
	}
	async #scan(storage: Storage, query: EntryQuery, limit: number, context: Context): Promise<EntryRecord[]> {
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanEntries(query, Math.min(256, limit - entries.length), cursor, context);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined && entries.length < limit);
		return entries;
	}
	async #build(storage: Storage, id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await storage.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const values: Record<string, JsonObject> = {};
		const docs = new Map<string, { id: DocumentId; version: number }>();
		for (const token of mounted) {
			const document = await this.#session.conversationDocumentOnLine(token, id, context);
			if (document !== undefined) {
				values[token.definition.kind] = document.value;
				docs.set(token.definition.kind, { id: document.record.id, version: document.version });
			}
		}
		return { conversation, values, docs, observers: new Set() };
	}
}
function observedValue<Value>(value: Value, observer: { detach(): void }): Observation<Value> {
	return { value, detach: () => observer.detach() };
}
function advance(
	id: ConversationId,
	mount: Mount,
	publication: ObservedCommit,
	context: Context,
	report: (error: unknown) => void,
): void {
	const documentOps: Op[] = [];
	const appended: EntryRecord[] = [];
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === id) {
			appended.push(change.value);
			continue;
		}
		if (
			change.type !== "document" ||
			change.conversationId !== id ||
			!mountedKinds.has(change.record.kind) ||
			change.record.key !== undefined
		)
			continue;
		const kind = change.record.kind;
		const path: NonEmptyPath = ["docs", kind];
		const previous = mount.docs.get(kind);
		if (change.kind === "retire") {
			if (previous?.id !== change.record.id) continue;
			mount.docs.delete(kind);
			documentOps.push(["d", path]);
		} else if (previous?.id === change.record.id && previous.version === change.version) {
			for (const operation of change.ops) documentOps.push(prefixed(operation, path));
		} else {
			mount.docs.set(kind, { id: change.record.id, version: change.version });
			documentOps.push(["s", path, change.value]);
		}
	}
	if (documentOps.length === 0 && appended.length === 0) return;
	if (documentOps.length > 0) mount.values = applyImmutable({ docs: mount.values }, documentOps).docs;
	const delivered = withoutAbortSignal(context);
	for (const subscription of [...mount.observers]) {
		let entries = subscription.value.entries;
		let before = subscription.value.before;
		const ops: Op[] = appended.length > 0 ? [...documentOps] : documentOps;
		if (appended.length > 0) {
			ops.push(["p", ["entries"], entries.length, 0, appended as unknown as JsonValue[]]);
			entries = entries.concat(appended);
			if (entries.length > subscription.max) {
				const count = entries.length - subscription.min;
				before = entries[count - 1]!.id;
				entries = entries.slice(count);
				ops.push(["p", ["entries"], 0, count, []], ["s", ["before"], before]);
			}
		}
		subscription.value = {
			conversation: mount.conversation,
			entries,
			...(before === undefined ? {} : { before }),
			docs: mount.values,
		};
		const call: WatchCall<ConversationView> = { kind: "value", value: subscription.value, ops, retired: false };
		contained(() => subscription.observer.advance(call, delivered), report);
	}
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
