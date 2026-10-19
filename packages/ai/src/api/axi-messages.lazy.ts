import { lazyApi } from "./lazy.ts";
export const axiMessagesApi = () => lazyApi(() => import("./axi-messages.ts"));
