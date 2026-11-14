import data from "./data/azure.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const AZURE_MODELS = flattenChatModelCatalog("azure", data);
export const AZURE_IMAGE_MODELS = flattenImageModelCatalog("azure", data);
export const AZURE_CLASSIFIER_MODELS = flattenClassifierModelCatalog("azure", data);
