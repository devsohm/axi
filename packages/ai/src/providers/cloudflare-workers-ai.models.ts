import data from "./data/cloudflare-workers-ai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const CLOUDFLARE_WORKERS_AI_MODELS = flattenChatModelCatalog("cloudflare-workers-ai", data);
export const CLOUDFLARE_WORKERS_AI_IMAGE_MODELS = flattenImageModelCatalog("cloudflare-workers-ai", data);
export const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS = flattenClassifierModelCatalog("cloudflare-workers-ai", data);
