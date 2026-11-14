import data from "./data/zai-coding-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const ZAI_CODING_CN_MODELS = flattenChatModelCatalog("zai-coding-cn", data);
export const ZAI_CODING_CN_IMAGE_MODELS = flattenImageModelCatalog("zai-coding-cn", data);
export const ZAI_CODING_CN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("zai-coding-cn", data);
