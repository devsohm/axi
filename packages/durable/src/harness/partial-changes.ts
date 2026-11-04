import type { Draft } from "@axi/objects/delta";
import type { JsonRepresentation, JsonValue } from "@axi/objects/json";
import { appendText } from "@axi/objects/delta";
import type { AssistantMessage, AssistantMessageEvent } from "@axi/ai";
import { type JsonChange, StreamingJsonParser } from "@axi/ai/utils/streaming-json";
import { type AssignPlan, assignJson } from "./json.ts";
import type { LiveState } from "./live.ts";

export type PartialMessage = JsonRepresentation<AssistantMessage>;
type Arguments = Record<string, JsonValue>;
export type PartialCommit = {
	readonly plan: AssignPlan;
	readonly toolCalls: ReadonlyMap<number, { readonly changes: readonly JsonChange[]; readonly snapshot: Arguments }>;
};
type PendingBlock =
	| { kind: "text" | "thinking"; text: string }
	| { kind: "tool"; parser: StreamingJsonParser; changes: JsonChange[]; applied: boolean };

export class PartialChanges {
	readonly #blocks = new Map<number, PendingBlock>();
	observe(event: AssistantMessageEvent): void {
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			const kind = event.type === "text_delta" ? "text" : "thinking";
			const prior = this.#blocks.get(event.contentIndex);
			if (prior?.kind === kind) prior.text += event.delta;
			else this.#blocks.set(event.contentIndex, { kind, text: event.delta });
		} else if (event.type === "toolcall_start") {
			this.#blocks.set(event.contentIndex, { kind: "tool", parser: new StreamingJsonParser(), changes: [], applied: false });
		} else if (event.type === "toolcall_delta") {
			const block = this.#blocks.get(event.contentIndex);
			if (block?.kind !== "tool") return;
			for (const change of block.parser.append(event.delta)) {
				if (!change.path.length && (change.kind !== "set" || !object(change.value))) {
					this.#blocks.delete(event.contentIndex);
					return;
				}
				block.changes.push(change);
			}
		} else if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") {
			this.#blocks.delete(event.contentIndex);
		}
	}
	take(message: PartialMessage): PartialCommit {
		const fields = new Map<string | number, AssignPlan>();
		const toolCalls = new Map<number, { changes: readonly JsonChange[]; snapshot: Arguments }>();
		for (const [index, block] of this.#blocks) {
			if (block.kind !== "tool") {
				fields.set(index, { kind: "fields", fields: new Map([[block.kind, { kind: "append", text: block.text }]]) });
				this.#blocks.delete(index);
				continue;
			}
			const call = message.content[index];
			if (call?.type !== "toolCall") continue;
			toolCalls.set(index, { changes: block.changes, snapshot: call.arguments });
			block.changes = [];
			call.arguments = {};
			fields.set(index, { kind: "fields", fields: new Map([["arguments", { kind: "keep" }]]) });
		}
		return { plan: { kind: "fields", fields: new Map([["content", { kind: "fields", fields }]]) }, toolCalls };
	}
	commit(generation: Draft<NonNullable<LiveState["generation"]>>, message: PartialMessage, batch: PartialCommit): void {
		const count = generation.message?.content.length ?? 0;
		const apply = new Map<number, readonly JsonChange[]>();
		for (const [index, update] of batch.toolCalls) {
			const pending = this.#blocks.get(index);
			if (pending?.kind !== "tool") continue;
			const call = message.content[index];
			if (pending.applied && index >= count && call?.type === "toolCall") {
				call.arguments = update.snapshot;
				this.#blocks.delete(index);
			} else {
				pending.applied = true;
				apply.set(index, update.changes);
			}
		}
		assignJson(generation, "message", message, batch.plan);
		for (const [index, changes] of apply) {
			const call = generation.message?.content[index];
			if (call?.type !== "toolCall") continue;
			for (const change of changes) {
				if (!change.path.length) {
					if (change.kind === "set" && object(change.value)) call.arguments = change.value as Arguments;
					continue;
				}
				let parent: Draft<JsonValue> = call.arguments;
				for (let i = 0; i < change.path.length - 1; i++) parent = Reflect.get(parent as object, change.path[i]!) as Draft<JsonValue>;
				const key = change.path.at(-1)!;
				if (change.kind === "set") Reflect.set(parent as object, key, change.value);
				else if (Array.isArray(parent)) parent[Number(key)] = `${parent[Number(key)]}${change.text}`;
				else appendText(parent as Draft<Record<string, string>>, String(key), change.text);
			}
		}
	}
	restore(batch: PartialCommit): void {
		for (const [index, update] of batch.toolCalls) {
			const pending = this.#blocks.get(index);
			if (pending?.kind === "tool") pending.changes = [...update.changes, ...pending.changes];
		}
	}
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
