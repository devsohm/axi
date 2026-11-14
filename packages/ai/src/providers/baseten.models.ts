import data from "./data/baseten.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const BASETEN_MODELS = flattenChatModelCatalog("baseten", data);
export const BASETEN_IMAGE_MODELS = flattenImageModelCatalog("baseten", data);
export const BASETEN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("baseten", data);
