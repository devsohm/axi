import data from "./data/openai-codex.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const OPENAI_CODEX_MODELS = flattenChatModelCatalog("openai-codex", data);
export const OPENAI_CODEX_IMAGE_MODELS = flattenImageModelCatalog("openai-codex", data);
export const OPENAI_CODEX_CLASSIFIER_MODELS = flattenClassifierModelCatalog("openai-codex", data);
