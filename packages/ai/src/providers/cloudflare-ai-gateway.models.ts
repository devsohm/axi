import data from "./data/cloudflare-ai-gateway.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const CLOUDFLARE_AI_GATEWAY_MODELS = flattenChatModelCatalog("cloudflare-ai-gateway", data);
export const CLOUDFLARE_AI_GATEWAY_IMAGE_MODELS = flattenImageModelCatalog("cloudflare-ai-gateway", data);
export const CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS = flattenClassifierModelCatalog("cloudflare-ai-gateway", data);
