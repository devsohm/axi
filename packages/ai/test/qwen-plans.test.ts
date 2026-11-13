import { expect, test } from "vitest";
import { buildModelsDevCatalog } from "../catalog/sources/models-dev.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { qwenTokenPlanProvider } from "../src/providers/qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "../src/providers/qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "../src/providers/qwen-token-plan-individual.ts";
import { qwenTokenPlanIndividualCnProvider } from "../src/providers/qwen-token-plan-individual-cn.ts";

const plans = [
	[qwenTokenPlanProvider, "TEAM", "", "qwencloudapi.com"],
	[qwenTokenPlanCnProvider, "TEAM", "_CN", "qianwenaiapi.com"],
	[qwenTokenPlanIndividualProvider, "INDIVIDUAL", "", "qwencloudapi.com"],
	[qwenTokenPlanIndividualCnProvider, "INDIVIDUAL", "_CN", "qianwenaiapi.com"],
] as const;

for (const [make, plan, region, domain] of plans) {
	test(`${make.name} separates plan credentials and retains regional fallback`, async () => {
		const provider = make(),
			specific = `QWEN_TOKEN_PLAN_${plan}${region}_API_KEY`,
			shared = `QWEN_TOKEN_PLAN${region}_API_KEY`;
		expect(provider.name).toBe(`Qwen Token Plan ${plan === "TEAM" ? "Team" : "Individual"}${region ? " CN" : ""}`);
		expect(provider.getModels()[0]?.baseUrl).toBe(`https://token-plan.maas.${domain}/compatible-mode/v1`);
		for (const [env, expected] of [
			[{ [specific]: "specific", [shared]: "regional" }, "specific"],
			[{ [shared]: "regional" }, "regional"],
			[{ [specific]: "", [shared]: "regional" }, "regional"],
			[{ [`QWEN_TOKEN_PLAN_${plan === "TEAM" ? "INDIVIDUAL" : "TEAM"}${region}_API_KEY`]: "other plan" }, undefined],
		] as const) {
			const models = createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });
			models.setProvider(provider);
			expect((await models.getAuth(provider.id))?.auth.apiKey).toBe(expected);
			expect(getEnvApiKey(provider.id, env)).toBe(expected);
			expect(findEnvKeys(provider.id, env)).toEqual(
				expected ? (env[specific] ? [specific, shared] : [shared]) : undefined,
			);
		}
		const ids = provider.getModels().map((model) => model.id);
		for (const retired of ["deepseek-v3.2", "deepseek-v4-flash", "qwen3.8-max-preview"])
			expect(ids).not.toContain(retired);
		if (plan === "INDIVIDUAL")
			expect(ids).toEqual(expect.arrayContaining(["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"]));
	});
}

test("Qwen catalog generation filters deprecated entries before applying the Individual allowlist", () => {
	const models = {
		"deepseek-v4.1-flash": { tool_call: true },
		"deepseek-v4.1-flash-1017": { tool_call: true },
		"deepseek-v4-pro": { tool_call: true, status: "deprecated" },
		"unlisted-team-model": { tool_call: true },
		"retired-team-model": { tool_call: true, status: "deprecated" },
	};
	const result = buildModelsDevCatalog({ "alibaba-token-plan": { models }, "alibaba-token-plan-cn": { models } });
	for (const [make, plan, , domain] of plans) {
		const selected = result.models.filter((model) => model.provider === make().id);
		expect(selected.map((model) => model.id).sort()).toEqual(
			["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", ...(plan === "TEAM" ? ["unlisted-team-model"] : [])].sort(),
		);
		for (const model of selected) expect(model.baseUrl).toBe(`https://token-plan.maas.${domain}/compatible-mode/v1`);
	}
});
