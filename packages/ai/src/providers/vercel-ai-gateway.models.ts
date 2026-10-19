import data from "./data/vercel-ai-gateway.json" with { type: "json" };
import { flattenChatModelCatalog, flattenImageModelCatalog, flattenClassifierModelCatalog } from "../model-catalog.ts";
export const VERCEL_AI_GATEWAY_MODELS = flattenChatModelCatalog("vercel-ai-gateway", data);
export const VERCEL_AI_GATEWAY_IMAGE_MODELS = flattenImageModelCatalog("vercel-ai-gateway", data);
export const VERCEL_AI_GATEWAY_CLASSIFIER_MODELS = flattenClassifierModelCatalog("vercel-ai-gateway", data);
