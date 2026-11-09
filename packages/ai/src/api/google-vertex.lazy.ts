import { lazyApi } from "./lazy.ts";
export const googleVertexApi = () => lazyApi(() => import("./google-vertex.ts"));
