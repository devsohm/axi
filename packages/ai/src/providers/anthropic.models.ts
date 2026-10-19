import data from "./data/anthropic.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const ANTHROPIC_MODELS = flattenChatModelCatalog("anthropic", data);
export const ANTHROPIC_IMAGE_MODELS = flattenImageModelCatalog("anthropic", data);
export const ANTHROPIC_CLASSIFIER_MODELS = flattenClassifierModelCatalog("anthropic", data);
