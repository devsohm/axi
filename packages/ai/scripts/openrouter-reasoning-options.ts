import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap } from "./models-dev-reasoning-options.ts";
export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: (ThinkingLevel | "none")[];
	default_effort?: ThinkingLevel | "none";
}
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const result = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts ?? [] }]);
	return result
		? { ...result, off: reasoning.mandatory ? null : "none" }
		: reasoning.mandatory === true
			? { off: null }
			: undefined;
}
