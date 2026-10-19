import data from "./data/openrouter.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const OPENROUTER_MODELS = flattenChatModelCatalog("openrouter", data);
export const OPENROUTER_IMAGE_MODELS = flattenImageModelCatalog("openrouter", data);
export const OPENROUTER_CLASSIFIER_MODELS = flattenClassifierModelCatalog("openrouter", data);
