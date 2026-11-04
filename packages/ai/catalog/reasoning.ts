import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| { type: "budget_tokens"; min?: number; max?: number }
	| { type: "effort"; values: (ThinkingLevel | "none" | "default" | null)[] };
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	const efforts = new Set(options.flatMap((option) => (option.type === "effort" ? option.values : [])));
	const levels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	if (!efforts.has("none") && !levels.some((level) => efforts.has(level))) return undefined;
	const result: ThinkingLevelMap = { off: efforts.has("none") ? "none" : null };
	for (const level of levels) result[level] = efforts.has(level) ? level : null;
	return result;
}
