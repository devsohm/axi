import data from "./data/moonshotai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const MOONSHOTAI_MODELS = flattenChatModelCatalog("moonshotai", data);
export const MOONSHOTAI_IMAGE_MODELS = flattenImageModelCatalog("moonshotai", data);
export const MOONSHOTAI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("moonshotai", data);
