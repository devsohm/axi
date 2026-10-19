import data from "./data/deepseek.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const DEEPSEEK_MODELS = flattenChatModelCatalog("deepseek", data);
export const DEEPSEEK_IMAGE_MODELS = flattenImageModelCatalog("deepseek", data);
export const DEEPSEEK_CLASSIFIER_MODELS = flattenClassifierModelCatalog("deepseek", data);
