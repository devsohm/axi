import data from "./data/zai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const ZAI_MODELS = flattenChatModelCatalog("zai", data);
export const ZAI_IMAGE_MODELS = flattenImageModelCatalog("zai", data);
export const ZAI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("zai", data);
