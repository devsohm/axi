import data from "./data/xai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const XAI_MODELS = flattenChatModelCatalog("xai", data);
export const XAI_IMAGE_MODELS = flattenImageModelCatalog("xai", data);
export const XAI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("xai", data);
