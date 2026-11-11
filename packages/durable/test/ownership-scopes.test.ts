import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { expect, test } from "vitest";
import { OwnershipTree, type StoredTask } from "../src/harness/ownership.ts";
import { idFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import type { ConversationId, TaskId } from "../src/types.ts";

const conversation = (value: number) => idFromNumber<ConversationId>(value);
const taskId = (value: number) => idFromNumber<TaskId<null>>(value);
function tree() {
	return new OwnershipTree(new MemoryStorage(), context, {
		read() {},
		onEnd() {},
		released() {},
		resolved() {},
	});
}
function task(id: number, scope: number, owner?: number): StoredTask {
	return {
		id: taskId(id),
		conversationId: conversation(scope),
		kind: "scope",
		version: 1,
		input: null,
		background: false,
		abortRequested: false,
		...(owner === undefined ? {} : { owner: taskId(owner) }),
		state: { status: "pending", checkpoint: { phase: "run" } },
	};
}

test("affected conversations include owned conversations' ancestors across task chains", () => {
	const ownership = tree();
	ownership.conversation(conversation(1), null);
	ownership.track(task(10, 1));
	ownership.track(task(11, 1, 10));
	ownership.conversation(conversation(2), taskId(11));
	ownership.track(task(12, 2));
	ownership.conversation(conversation(3), taskId(12));
	const scopes = new Set<ConversationId>();
	expect(ownership.addConversationAncestors(conversation(3), scopes)).toBe(true);
	expect([...scopes]).toEqual([conversation(3), conversation(2), conversation(1)]);
});

test("unknown conversation ownership or an unloaded owning task requests a complete check", () => {
	const ownership = tree();
	const scopes = new Set<ConversationId>();
	expect(ownership.addConversationAncestors(conversation(1), scopes)).toBe(false);
	ownership.conversation(conversation(2), taskId(10));
	expect(ownership.addConversationAncestors(conversation(2), new Set())).toBe(false);
});

test("a deep task chain still affects only its containing conversation", () => {
	const ownership = tree();
	ownership.conversation(conversation(1), null);
	for (let id = 10; id < 10_010; id++) ownership.track(task(id, 1, id === 10 ? undefined : id - 1));
	const scopes = new Set<ConversationId>();
	expect(ownership.addConversationAncestors(conversation(1), scopes)).toBe(true);
	expect([...scopes]).toEqual([conversation(1)]);
});
