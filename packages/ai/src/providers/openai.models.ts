import data from "./data/openai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const OPENAI_MODELS = flattenChatModelCatalog("openai", data);
export const OPENAI_IMAGE_MODELS = flattenImageModelCatalog("openai", data);
export const OPENAI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("openai", data);
