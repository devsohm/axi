import data from "./data/groq.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const GROQ_MODELS = flattenChatModelCatalog("groq", data);
export const GROQ_IMAGE_MODELS = flattenImageModelCatalog("groq", data);
export const GROQ_CLASSIFIER_MODELS = flattenClassifierModelCatalog("groq", data);
