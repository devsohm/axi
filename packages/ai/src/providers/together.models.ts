import data from "./data/together.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const TOGETHER_MODELS = flattenChatModelCatalog("together", data);
export const TOGETHER_IMAGE_MODELS = flattenImageModelCatalog("together", data);
export const TOGETHER_CLASSIFIER_MODELS = flattenClassifierModelCatalog("together", data);
