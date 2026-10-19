import data from "./data/google-vertex.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const GOOGLE_VERTEX_MODELS = flattenChatModelCatalog("google-vertex", data);
export const GOOGLE_VERTEX_IMAGE_MODELS = flattenImageModelCatalog("google-vertex", data);
export const GOOGLE_VERTEX_CLASSIFIER_MODELS = flattenClassifierModelCatalog("google-vertex", data);
