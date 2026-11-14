import data from "./data/xiaomi.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const XIAOMI_MODELS = flattenChatModelCatalog("xiaomi", data);
export const XIAOMI_IMAGE_MODELS = flattenImageModelCatalog("xiaomi", data);
export const XIAOMI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("xiaomi", data);
