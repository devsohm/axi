import data from "./data/github-copilot.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const GITHUB_COPILOT_MODELS = flattenChatModelCatalog("github-copilot", data);
export const GITHUB_COPILOT_IMAGE_MODELS = flattenImageModelCatalog("github-copilot", data);
export const GITHUB_COPILOT_CLASSIFIER_MODELS = flattenClassifierModelCatalog("github-copilot", data);
