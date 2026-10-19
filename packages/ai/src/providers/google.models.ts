import data from "./data/google.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const GOOGLE_MODELS = flattenChatModelCatalog("google", data);
export const GOOGLE_IMAGE_MODELS = flattenImageModelCatalog("google", data);
export const GOOGLE_CLASSIFIER_MODELS = flattenClassifierModelCatalog("google", data);
