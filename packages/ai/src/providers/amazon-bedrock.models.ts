import data from "./data/amazon-bedrock.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const AMAZON_BEDROCK_MODELS = flattenChatModelCatalog("amazon-bedrock", data);
export const AMAZON_BEDROCK_IMAGE_MODELS = flattenImageModelCatalog("amazon-bedrock", data);
export const AMAZON_BEDROCK_CLASSIFIER_MODELS = flattenClassifierModelCatalog("amazon-bedrock", data);
