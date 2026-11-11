import Type, { type TUnsafe } from "typebox";
import type { Address, HostKind, KindShape } from "../contracts/index.ts";
import { addressOfKey, keyOfAddress, kindParams, type Params } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import { storedText } from "./text.ts";

export type HostColumnSchema<K extends KindShape> = TUnsafe<Address<K>> & { readonly host: HostColumn };

export function host<N extends string, P extends Params>(kind: HostKind<N, P>): HostColumnSchema<HostKind<N, P>> {
	return Object.assign(Type.Unsafe<Address<HostKind<N, P>>>({}), { host: new HostColumn(kind) });
}

export class HostColumn {
	readonly kind: KindShape;
	constructor(kind: KindShape) {
		kindParams(kind);
		this.kind = kind;
	}
	key(value: unknown, label: string): string {
		const encoded = keyOfAddress(this.kind, value);
		if (encoded === undefined) throw invalid("args", `${label}: expected an address of ${this.kind.kind}`);
		return storedText(encoded, label);
	}
	address(key: string): Address {
		return addressOfKey(this.kind, key);
	}
}
