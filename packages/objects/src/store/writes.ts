import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";

export type StoreWrite = DocumentWrite | TableWrite;
