import { lazyApi } from "./lazy.ts";
export const mistralConversationsApi = () => lazyApi(() => import("./mistral-conversations.ts"));
