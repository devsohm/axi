import data from "./data/minimax.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const MINIMAX_MODELS = flattenChatModelCatalog("minimax", data);
export const MINIMAX_IMAGE_MODELS = flattenImageModelCatalog("minimax", data);
export const MINIMAX_CLASSIFIER_MODELS = flattenClassifierModelCatalog("minimax", data);
