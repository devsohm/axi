import data from "./data/xiaomi-token-plan-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const XIAOMI_TOKEN_PLAN_CN_MODELS = flattenChatModelCatalog("xiaomi-token-plan-cn", data);
export const XIAOMI_TOKEN_PLAN_CN_IMAGE_MODELS = flattenImageModelCatalog("xiaomi-token-plan-cn", data);
export const XIAOMI_TOKEN_PLAN_CN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("xiaomi-token-plan-cn", data);
