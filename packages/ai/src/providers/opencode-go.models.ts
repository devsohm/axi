import data from "./data/opencode-go.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const OPENCODE_GO_MODELS = flattenChatModelCatalog("opencode-go", data);
export const OPENCODE_GO_IMAGE_MODELS = flattenImageModelCatalog("opencode-go", data);
export const OPENCODE_GO_CLASSIFIER_MODELS = flattenClassifierModelCatalog("opencode-go", data);
