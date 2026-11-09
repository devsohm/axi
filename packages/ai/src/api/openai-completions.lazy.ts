import { lazyApi } from "./lazy.ts";
export const openAICompletionsApi = () => lazyApi(() => import("./openai-completions.ts"));
