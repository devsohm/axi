import data from "./data/mistral.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const MISTRAL_MODELS = flattenChatModelCatalog("mistral", data);
export const MISTRAL_IMAGE_MODELS = flattenImageModelCatalog("mistral", data);
export const MISTRAL_CLASSIFIER_MODELS = flattenClassifierModelCatalog("mistral", data);
