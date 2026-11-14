import data from "./data/qwen-token-plan-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const QWEN_TOKEN_PLAN_CN_MODELS = flattenChatModelCatalog("qwen-token-plan-cn", data);
export const QWEN_TOKEN_PLAN_CN_IMAGE_MODELS = flattenImageModelCatalog("qwen-token-plan-cn", data);
export const QWEN_TOKEN_PLAN_CN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("qwen-token-plan-cn", data);
