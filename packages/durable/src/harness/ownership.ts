import type { Context, JsonValue } from "@axi/chord";
import type { ConversationId, Storage, TaskId, TaskRecord } from "../types.ts";
import type { Transaction } from "../session/transaction.ts";

export type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TaskLink = Pick<StoredTask, "owner" | "conversationId" | "background">;
type ConversationNode = `c${number}`;
export type OwnershipNode = TaskId | ConversationNode;
export type OwnershipOverlay = {
	readonly tasks: ReadonlyMap<TaskId, StoredTask>;
	readonly conversations: ReadonlyMap<ConversationId, TaskId | null>;
	links?: ReadonlyMap<OwnershipNode, ReadonlySet<OwnershipNode>>;
};
export type Descendant = { readonly id: TaskId; readonly node: TaskLink; readonly live: StoredTask | undefined };
export const conversationNode = (id: ConversationId): ConversationNode => `c${id}`;
export const taskParent = (task: TaskLink): OwnershipNode => task.owner ?? conversationNode(task.conversationId);
const conversationId = (node: ConversationNode): ConversationId => Number(node.slice(1)) as ConversationId;

export function ownershipOverlay(tx: Transaction): OwnershipOverlay {
	return {
		tasks: new Map(tx.stagedTasks().map((task) => [task.id, task])),
		conversations: new Map(tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null])),
	};
}

export class OwnershipTree {
	readonly live = new Map<TaskId, StoredTask>();
	readonly #ended = new Map<TaskId, TaskLink>();
	readonly #conversations = new Map<ConversationId, TaskId | null>();
	readonly #children = new Map<OwnershipNode, Set<OwnershipNode>>();
	readonly #roots = new Set<ConversationId>();
	readonly #unknown = new Set<TaskId>();
	readonly #garbage = new Set<OwnershipNode>();
	readonly storage: Storage;
	readonly context: Context;
	constructor(storage: Storage, context: Context) {
		this.storage = storage;
		this.context = context;
	}

	track(record: StoredTask): void {
		const previous = this.live.get(record.id);
		if (record.state.status === "terminal") {
			this.live.delete(record.id);
			this.#ended.set(record.id, {
				conversationId: record.conversationId,
				background: record.background,
				...(record.owner === undefined ? {} : { owner: record.owner }),
			});
		} else {
			this.live.set(record.id, record);
			if (previous === undefined && !this.known(taskParent(record))) this.#unknown.add(record.id);
		}
		this.#relink(record.id);
		this.#queueDrop(record.id);
	}

	conversation(id: ConversationId, owner: TaskId | null): void {
		this.#conversations.set(id, owner);
		this.#relink(conversationNode(id));
		this.#queueDrop(conversationNode(id));
	}

	#task(id: TaskId, overlay?: OwnershipOverlay): TaskLink | undefined {
		return overlay?.tasks.get(id) ?? this.live.get(id) ?? this.#ended.get(id);
	}
	#parent(node: OwnershipNode, overlay?: OwnershipOverlay): OwnershipNode | null | undefined {
		if (typeof node === "number") {
			const task = this.#task(node, overlay);
			return task === undefined ? undefined : taskParent(task);
		}
		const id = conversationId(node);
		return overlay?.conversations.has(id) ? overlay.conversations.get(id) : this.#conversations.get(id);
	}
	known(node: OwnershipNode): boolean {
		if (typeof node === "number") return this.#task(node) !== undefined && !this.#unknown.has(node);
		const owner = this.#parent(node);
		return owner === null || (owner !== undefined && this.known(owner));
	}

	async load(start: OwnershipNode, overlay?: OwnershipOverlay): Promise<void> {
		const passed: TaskId[] = [];
		let node: OwnershipNode | null | undefined = start;
		while (node !== undefined && node !== null) {
			if (typeof node === "number") {
				let task = this.#task(node);
				if (task === undefined && overlay?.tasks.has(node)) break;
				if (task !== undefined && !this.#unknown.has(node)) break;
				if (task === undefined) {
					const stored = await this.storage.task(node, this.context);
					if (stored === undefined) return;
					task = {
						conversationId: stored.conversationId,
						background: stored.background,
						...(stored.owner === undefined ? {} : { owner: stored.owner }),
					};
					this.#ended.set(node, task);
					this.#unknown.add(node);
					this.#relink(node);
					this.#queueDrop(node);
				}
				passed.push(node);
				node = taskParent(task);
			} else {
				let owner = this.#parent(node, overlay);
				if (owner === undefined) {
					const id = conversationId(node);
					owner = (await this.storage.conversation(id, this.context))?.owner?.taskId ?? null;
					this.conversation(id, owner);
				}
				node = owner;
			}
		}
		for (const id of passed) this.#unknown.delete(id);
	}
	async loadAll(): Promise<void> {
		for (const id of this.#unknown) await this.load(id);
	}

	#relink(start: OwnershipNode): void {
		let child = start;
		for (;;) {
			const keep = (typeof child === "number" && this.live.has(child)) || this.#children.has(child);
			const parent = this.#parent(child);
			if (parent === undefined) return;
			if (parent === null) {
				if (typeof child === "string") {
					if (keep) this.#roots.add(conversationId(child));
					else this.#roots.delete(conversationId(child));
				}
				return;
			}
			const siblings = this.#children.get(parent);
			if ((siblings?.has(child) === true) === keep) return;
			if (keep) {
				if (siblings !== undefined) {
					siblings.add(child);
					return;
				}
				this.#children.set(parent, new Set([child]));
			} else {
				siblings?.delete(child);
				if (siblings?.size) return;
				this.#children.delete(parent);
				this.#queueDrop(parent);
			}
			child = parent;
		}
	}
	#queueDrop(node: OwnershipNode): void {
		if ((typeof node === "number" && this.live.has(node)) || this.#children.has(node)) return;
		this.#garbage.add(node);
	}
	prune(): void {
		for (const node of this.#garbage) {
			if (this.#children.has(node)) continue;
			if (typeof node === "string") {
				this.#conversations.delete(conversationId(node));
				this.#roots.delete(conversationId(node));
			} else if (!this.live.has(node)) {
				this.#ended.delete(node);
				this.#unknown.delete(node);
			}
		}
		this.#garbage.clear();
	}
	get hasGarbage(): boolean {
		return this.#garbage.size > 0;
	}

	#extraChildren(overlay: OwnershipOverlay): ReadonlyMap<OwnershipNode, ReadonlySet<OwnershipNode>> {
		if (overlay.links !== undefined) return overlay.links;
		const links = new Map<OwnershipNode, Set<OwnershipNode>>();
		for (const record of overlay.tasks.values()) {
			if (this.#task(record.id) !== undefined) continue;
			let child: OwnershipNode = record.id;
			for (let parent = taskParent(record); ; ) {
				const siblings = links.get(parent) ?? new Set<OwnershipNode>();
				if (siblings.has(child)) break;
				siblings.add(child);
				links.set(parent, siblings);
				if (typeof parent === "number" && (this.live.has(parent) || overlay.tasks.has(parent))) break;
				const above = this.#parent(parent, overlay);
				if (above === undefined || above === null || this.#children.get(above)?.has(parent)) break;
				child = parent;
				parent = above;
			}
		}
		overlay.links = links;
		return links;
	}
	*descendants(
		start: OwnershipNode,
		options: {
			readonly overlay?: OwnershipOverlay;
			readonly background?: boolean;
			readonly enter?: (id: TaskId) => boolean;
		} = {},
	): Generator<Descendant> {
		const extra = options.overlay === undefined ? undefined : this.#extraChildren(options.overlay);
		const stack = [start];
		for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
			for (const children of [this.#children.get(parent), extra?.get(parent)]) {
				for (const child of children ?? []) {
					if (typeof child === "string") {
						stack.push(child);
						continue;
					}
					const record = options.overlay?.tasks.get(child) ?? this.live.get(child);
					const node = record ?? this.#ended.get(child);
					if (node === undefined) continue;
					yield { id: child, node, live: record?.state.status === "terminal" ? undefined : record };
					if ((options.background || !node.background) && (options.enter?.(child) ?? true)) stack.push(child);
				}
			}
		}
	}
	owned(owner: TaskId, overlay?: OwnershipOverlay, first = false, skip?: ReadonlySet<TaskId>): TaskId[] {
		const result: TaskId[] = [];
		for (const child of this.descendants(owner, {
			...(overlay === undefined ? {} : { overlay }),
			...(skip === undefined ? {} : { enter: (id: TaskId) => !skip.has(id) }),
		})) {
			if (child.live === undefined || child.node.background) continue;
			result.push(child.id);
			if (first) break;
		}
		return result;
	}
	*ancestors(
		start: OwnershipNode,
		overlay?: OwnershipOverlay,
	): Generator<
		| { readonly kind: "task"; readonly id: TaskId; readonly node: TaskLink }
		| { readonly kind: "conversation"; readonly id: ConversationId }
		| { readonly kind: "unknown" }
	> {
		let at: OwnershipNode | null | undefined = start;
		while (at !== null && at !== undefined) {
			if (typeof at === "number") {
				const task = this.#task(at, overlay);
				if (task === undefined) {
					yield { kind: "unknown" };
					return;
				}
				yield { kind: "task", id: at, node: task };
			} else yield { kind: "conversation", id: conversationId(at) };
			at = this.#parent(at, overlay);
			if (at === undefined) yield { kind: "unknown" };
		}
	}
	nearest(task: TaskLink, overlay?: OwnershipOverlay): StoredTask | undefined {
		if (task.background) return;
		for (const step of this.ancestors(taskParent(task), overlay)) {
			if (step.kind === "unknown") return;
			if (step.kind !== "task") continue;
			const record = overlay?.tasks.get(step.id) ?? this.live.get(step.id);
			if (record !== undefined && record.state.status !== "terminal") return record;
			if (step.node.background) return;
		}
	}
	inScope(start: OwnershipNode, scope: ConversationId | undefined, background = false): boolean | undefined {
		for (const step of this.ancestors(start)) {
			if (step.kind === "unknown") return;
			if (step.kind === "conversation" && scope === step.id) return true;
			if (step.kind === "task" && step.node.background && !background) return false;
		}
		return scope === undefined;
	}
	idle(scope: ConversationId | undefined): boolean {
		for (const id of this.#unknown) {
			const record = this.live.get(id);
			if (record && !record.background && this.inScope(taskParent(record), scope) !== false) return false;
		}
		for (const root of scope === undefined ? this.#roots : [scope]) {
			for (const child of this.descendants(conversationNode(root))) {
				if (child.live !== undefined && !child.node.background) return false;
			}
		}
		return true;
	}
	direct(owner: TaskId): StoredTask[] {
		const tasks: StoredTask[] = [];
		for (const id of this.#children.get(owner) ?? []) {
			const task = typeof id === "number" ? this.live.get(id) : undefined;
			if (task?.owner === owner) tasks.push(task);
		}
		return tasks.sort((left, right) => left.id - right.id);
	}
	get sizes() {
		let below = 0;
		for (const children of this.#children.values()) below += children.size;
		return {
			live: this.live.size,
			settled: this.#ended.size,
			edges: this.#conversations.size,
			below,
			roots: this.#roots.size,
			unloaded: this.#unknown.size,
			dropQueue: this.#garbage.size,
		};
	}
}
