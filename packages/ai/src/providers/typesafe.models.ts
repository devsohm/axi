import data from "./data/typesafe.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const TYPESAFE_MODELS = flattenChatModelCatalog("typesafe", data);
export const TYPESAFE_IMAGE_MODELS = flattenImageModelCatalog("typesafe", data);
export const TYPESAFE_CLASSIFIER_MODELS = flattenClassifierModelCatalog("typesafe", data);
