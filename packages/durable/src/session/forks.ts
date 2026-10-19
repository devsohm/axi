import type { Context } from "@axi/chord";
import { addressId } from "../documents.ts";
import type {
	ConversationId,
	Cursor,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	EntryId,
	Storage,
} from "../types.ts";
export type ForkDocumentCopy = { readonly record: DocumentCreate; readonly source: DocumentCopySource };
export async function prepareForkDocumentCopies(
	storage: Storage,
	parent: ConversationId,
	at: EntryId,
	child: ConversationId,
	context: Context,
): Promise<readonly ForkDocumentCopy[]> {
	const entry = await storage.entry(parent, at, context);
	if (!entry) throw new Error(`Entry ${at} is not visible from conversation ${parent}`);
	const result: ForkDocumentCopy[] = [];
	const addresses = new Set<string>();
	const selections: readonly [ConversationId, DocumentPoint, "asOf" | "current"][] = [
		[entry.entry.conversationId, entry.commitSeq, "asOf"],
		[parent, "current", "current"],
	];
	for (const [conversationId, point, policy] of selections) {
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanDocuments(
				{ scope: { kind: "conversation", conversationId }, at: point },
				256,
				cursor,
				context,
			);
			for (const source of page.items) {
				if (source.scope.kind !== "conversation" || source.fork !== policy) continue;
				const id = await storage.mintId<DocumentId>();
				const base = {
					id,
					kind: source.kind,
					...(source.key === undefined ? {} : { key: source.key }),
					scope: { kind: "conversation" as const, conversationId: child },
				};
				const record: DocumentCreate =
					source.history === "latest"
						? { ...base, history: "latest", fork: source.fork }
						: { ...base, history: "rewindable", fork: source.fork };
				const identity = addressId(record);
				if (addresses.has(identity))
					throw new Error(
						`Fork selects multiple source documents for ${record.kind}${record.key === undefined ? "" : `/${record.key}`}`,
					);
				addresses.add(identity);
				result.push({ record, source: { id: source.id, at: point } });
			}
			cursor = page.next;
		} while (cursor !== undefined);
	}
	return result;
}
