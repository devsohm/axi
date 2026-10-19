import type { Context } from "@axi/chord";
import { uuidv7 } from "@axi/ai/utils/uuid";
import { defineDoc } from "../documents.ts";
import type { TaskRuntime } from "../types.ts";

export type ProviderState = { sessionId: string };
export const ProviderDoc = defineDoc<ProviderState>({
	kind: "axi.provider",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ sessionId: uuidv7() }),
	checkpointWhen: () => true,
});
export async function ensureProviderSessionId<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
): Promise<string> {
	const state = await runtime.snapshot(ProviderDoc, runtime.conversationId, context);
	if (state !== undefined) return state.sessionId;
	let value: string | undefined;
	await runtime.commit(async (tx) => {
		value = (await tx.doc(ProviderDoc, runtime.conversationId)).sessionId;
	}, context);
	if (value === undefined) throw new Error(`Conversation ${runtime.conversationId} has no provider session ID`);
	return value;
}
