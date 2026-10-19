import data from "./data/meta.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const META_MODELS = flattenChatModelCatalog("meta", data);
export const META_IMAGE_MODELS = flattenImageModelCatalog("meta", data);
export const META_CLASSIFIER_MODELS = flattenClassifierModelCatalog("meta", data);
