import { lazyApi } from "./lazy.ts";
export const anthropicMessagesApi = () => lazyApi(() => import("./anthropic-messages.ts"));
