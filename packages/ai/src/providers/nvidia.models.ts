import data from "./data/nvidia.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const NVIDIA_MODELS = flattenChatModelCatalog("nvidia", data);
export const NVIDIA_IMAGE_MODELS = flattenImageModelCatalog("nvidia", data);
export const NVIDIA_CLASSIFIER_MODELS = flattenClassifierModelCatalog("nvidia", data);
