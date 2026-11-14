import data from "./data/cerebras.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const CEREBRAS_MODELS = flattenChatModelCatalog("cerebras", data);
export const CEREBRAS_IMAGE_MODELS = flattenImageModelCatalog("cerebras", data);
export const CEREBRAS_CLASSIFIER_MODELS = flattenClassifierModelCatalog("cerebras", data);
