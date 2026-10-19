import data from "./data/qwen-token-plan-individual.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS = flattenChatModelCatalog("qwen-token-plan-individual", data);
export const QWEN_TOKEN_PLAN_INDIVIDUAL_IMAGE_MODELS = flattenImageModelCatalog("qwen-token-plan-individual", data);
export const QWEN_TOKEN_PLAN_INDIVIDUAL_CLASSIFIER_MODELS = flattenClassifierModelCatalog(
	"qwen-token-plan-individual",
	data,
);
