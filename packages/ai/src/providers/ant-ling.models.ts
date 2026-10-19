import data from "./data/ant-ling.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const ANT_LING_MODELS = flattenChatModelCatalog("ant-ling", data);
export const ANT_LING_IMAGE_MODELS = flattenImageModelCatalog("ant-ling", data);
export const ANT_LING_CLASSIFIER_MODELS = flattenClassifierModelCatalog("ant-ling", data);
