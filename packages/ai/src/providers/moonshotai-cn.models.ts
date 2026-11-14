import data from "./data/moonshotai-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const MOONSHOTAI_CN_MODELS = flattenChatModelCatalog("moonshotai-cn", data);
export const MOONSHOTAI_CN_IMAGE_MODELS = flattenImageModelCatalog("moonshotai-cn", data);
export const MOONSHOTAI_CN_CLASSIFIER_MODELS = flattenClassifierModelCatalog("moonshotai-cn", data);
