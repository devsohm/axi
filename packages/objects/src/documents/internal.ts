export { SealToken } from "./fence.ts";
export { AddressSource } from "./address-source.ts";
export { Documents, type DocumentsOwner } from "./documents.ts";
export { Keyed, Singleton, type KeyDeclarer } from "./handles.ts";
export { type ChangedDocument, type KeyedSlot, KeySource } from "./keyed-slot.ts";
export {
	Persistence,
	storedAfter,
	type Stored,
	type StoredChange,
	type DocumentChange,
	type Held,
} from "./persistence.ts";
export {
	SlotDefinition,
	type AnyDefinition,
	type DocumentSlot,
	type PersistedSlot,
} from "./slot.ts";
export type { Transaction, Staged } from "./transaction.ts";
