import data from "./data/fireworks.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const FIREWORKS_MODELS = flattenChatModelCatalog("fireworks", data);
export const FIREWORKS_IMAGE_MODELS = flattenImageModelCatalog("fireworks", data);
export const FIREWORKS_CLASSIFIER_MODELS = flattenClassifierModelCatalog("fireworks", data);
