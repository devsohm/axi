import data from "./data/qwen-token-plan.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const QWEN_TOKEN_PLAN_MODELS = flattenChatModelCatalog("qwen-token-plan", data);
export const QWEN_TOKEN_PLAN_IMAGE_MODELS = flattenImageModelCatalog("qwen-token-plan", data);
export const QWEN_TOKEN_PLAN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("qwen-token-plan", data);
