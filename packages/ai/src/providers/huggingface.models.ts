import data from "./data/huggingface.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const HUGGINGFACE_MODELS = flattenChatModelCatalog("huggingface", data);
export const HUGGINGFACE_IMAGE_MODELS = flattenImageModelCatalog("huggingface", data);
export const HUGGINGFACE_CLASSIFIER_MODELS = flattenClassifierModelCatalog("huggingface", data);
