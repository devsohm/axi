import data from "./data/minimax-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const MINIMAX_CN_MODELS = flattenChatModelCatalog("minimax-cn", data);
export const MINIMAX_CN_IMAGE_MODELS = flattenImageModelCatalog("minimax-cn", data);
export const MINIMAX_CN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("minimax-cn", data);
