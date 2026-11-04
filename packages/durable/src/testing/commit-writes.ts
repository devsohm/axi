import type { Context } from "@axi/objects";
import type { Seq, Storage, StorageWrite } from "../types.ts";

export async function commitWrites(storage: Storage, writes: readonly StorageWrite[], context: Context): Promise<Seq> {
	const seqs: Seq[] = [];
	const result = await storage.commit([writes], (_index, seq) => seqs.push(seq), context);
	if (result.stored === 0) throw result.refused;
	return seqs[0];
}
