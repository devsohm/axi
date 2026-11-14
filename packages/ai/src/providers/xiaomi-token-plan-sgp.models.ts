import data from "./data/xiaomi-token-plan-sgp.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const XIAOMI_TOKEN_PLAN_SGP_MODELS = flattenChatModelCatalog("xiaomi-token-plan-sgp", data);
export const XIAOMI_TOKEN_PLAN_SGP_IMAGE_MODELS = flattenImageModelCatalog("xiaomi-token-plan-sgp", data);
export const XIAOMI_TOKEN_PLAN_SGP_CLASSIFIER_MODELS = flattenClassifierModelCatalog("xiaomi-token-plan-sgp", data);
