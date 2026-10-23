import type { Usage } from "../types.ts";

export interface OpenRouterUsageAccounting {
	cost: number | null;
	is_byok: boolean;
	cost_details: {
		upstream_inference_cost: number | null;
		upstream_inference_prompt_cost: number;
		upstream_inference_completions_cost: number;
		server_tool_cost?: number | null;
	} | null;
}

function amount(value: unknown): value is number {
	return typeof value === "number" && value >= 0 && Number.isFinite(value);
}
export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
}
export function applyOpenRouterReportedCost(usage: Usage, reported: unknown): void {
	if (!reported || typeof reported !== "object" || !("cost" in reported) || !amount(reported.cost)) return;
	if (!("is_byok" in reported)) return;
	let total = reported.cost;
	if (reported.is_byok === true) {
		if (!("cost_details" in reported)) return;
		const details = reported.cost_details;
		if (!details || typeof details !== "object" || !("upstream_inference_cost" in details)) return;
		let upstream = details.upstream_inference_cost;
		if (upstream === null) {
			if (
				!("upstream_inference_prompt_cost" in details) ||
				!amount(details.upstream_inference_prompt_cost) ||
				!("upstream_inference_completions_cost" in details) ||
				!amount(details.upstream_inference_completions_cost)
			)
				return;
			upstream = details.upstream_inference_prompt_cost + details.upstream_inference_completions_cost;
		}
		if (!amount(upstream)) return;
		total += upstream;
	} else if (reported.is_byok !== false) return;
	usage.cost.total = total;
	usage.cost.totalFromProvider = true;
}
