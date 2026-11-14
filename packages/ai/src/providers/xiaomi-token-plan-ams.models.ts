import data from "./data/xiaomi-token-plan-ams.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const XIAOMI_TOKEN_PLAN_AMS_MODELS = flattenChatModelCatalog("xiaomi-token-plan-ams", data);
export const XIAOMI_TOKEN_PLAN_AMS_IMAGE_MODELS = flattenImageModelCatalog("xiaomi-token-plan-ams", data);
export const XIAOMI_TOKEN_PLAN_AMS_CLASSIFIER_MODELS = flattenClassifierModelCatalog("xiaomi-token-plan-ams", data);
