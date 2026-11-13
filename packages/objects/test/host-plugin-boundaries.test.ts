import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { constant, createHost, defineFacet, defineRegistry, int, local } from "../src/index.ts";

test.each(["contract", "registry"] as const)(
	"duplicate %s providers fail without publishing a partial replacement",
	async (kind) => {
		const Value = local("checked.ownership", { version: 1, params: {}, members: { value: int() } });
		const Total = defineRegistry<number, number>("checked.ownership-total", { version: 1 });
		const host = createHost({ onError() {} });
		const facet = (value: number, duplicate = false) =>
			defineFacet((facet) => {
				if (kind === "contract") {
					facet.serve(Value, () => ({ value: constant(value) }));
					if (duplicate) facet.serve(Value, () => ({ value: constant(99) }));
				} else {
					facet.serve(Total, { compose: () => value });
					if (duplicate) facet.serve(Total, { compose: () => 99 });
				}
			});
		try {
			const first = { name: "first", facet: facet(7) };
			const loaded = await host.load([first, { name: "second", facet: facet(99) }], context);
			expect(loaded.failed).toMatchObject([
				{ plugin: "second", error: { message: expect.stringContaining("served twice") } },
			]);
			const failed = await host.reload([{ name: "first", facet: facet(99, true) }], context);
			expect(failed.failed).toMatchObject([
				{ plugin: "first", error: { message: expect.stringContaining("served twice") } },
			]);
			if (kind === "contract") {
				const ref = await host.get(Value, {}, context);
				try {
					expect(ref.value.value).toBe(7);
				} finally {
					ref.release();
				}
			} else expect((await host.registry(Total, context)).value).toBe(7);
			expect((await host.reload([{ name: "first", facet: facet(11) }], context)).failed).toEqual([]);
			if (kind === "contract") {
				const ref = await host.get(Value, {}, context);
				try {
					expect(ref.value.value).toBe(11);
				} finally {
					ref.release();
				}
			} else expect((await host.registry(Total, context)).value).toBe(11);
		} finally {
			await host.close(context);
		}
	},
);
