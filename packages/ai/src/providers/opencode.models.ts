import data from "./data/opencode.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const OPENCODE_MODELS = flattenChatModelCatalog("opencode", data);
export const OPENCODE_IMAGE_MODELS = flattenImageModelCatalog("opencode", data);
export const OPENCODE_CLASSIFIER_MODELS = flattenClassifierModelCatalog("opencode", data);
