import { copyJson, type Draft, type JsonRepresentation } from "@axi/chord";
import type { Usage } from "@axi/ai";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

export type UsageState = {
	models: Record<string, JsonRepresentation<Usage>>;
	tools: Record<string, JsonRepresentation<Usage>>;
};
export const UsageDoc = defineDoc<UsageState>({
	kind: "axi.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});
export function addUsage(total: Draft<Usage> | Usage, value: Usage): void {
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		total[field] += value[field];
	for (const field of ["cacheWrite1h", "reasoning"] as const)
		if (value[field] !== undefined) total[field] = (total[field] ?? 0) + value[field];
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		total.cost[field] += value.cost[field];
}
export async function recordUsage(
	tx: Tx,
	id: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, id))[bucket];
	if (Object.hasOwn(totals, key) && totals[key] !== undefined) addUsage(totals[key], usage);
	else totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
}
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const)
		for (const [key, value] of Object.entries(state[bucket])) {
			if (Object.hasOwn(sum[bucket], key) && sum[bucket][key] !== undefined) addUsage(sum[bucket][key], value);
			else Object.defineProperty(sum[bucket], key, { value: structuredClone(value), enumerable: true, writable: true });
		}
}
