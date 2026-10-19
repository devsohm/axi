import { expectTypeOf, it } from "vitest";
import type { Draft } from "../src/delta/draft.ts";

declare const identity: unique symbol;
type RecordId = number & { readonly [identity]: "record" };
type Label = string & { readonly [identity]: "label" };

it("keeps branded scalar IDs inside mutable drafts", () => {
	expectTypeOf<Draft<RecordId>>().toEqualTypeOf<RecordId>();
	expectTypeOf<Draft<Label>>().toEqualTypeOf<Label>();
	expectTypeOf<Draft<{ readonly id: RecordId; readonly pair: readonly [Label, RecordId] }>>().toEqualTypeOf<{
		id: RecordId;
		pair: [Label, RecordId];
	}>();
});
