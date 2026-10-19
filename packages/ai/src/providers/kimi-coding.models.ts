import data from "./data/kimi-coding.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const KIMI_CODING_MODELS = flattenChatModelCatalog("kimi-coding", data);
export const KIMI_CODING_IMAGE_MODELS = flattenImageModelCatalog("kimi-coding", data);
export const KIMI_CODING_CLASSIFIER_MODELS = flattenClassifierModelCatalog("kimi-coding", data);
