import { lazyApi } from "./lazy.ts";
export const googleGenerativeAIApi = () => lazyApi(() => import("./google-generative-ai.ts"));
