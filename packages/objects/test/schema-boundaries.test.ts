import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet, local, map, method, obj, opt, str } from "../src/index.ts";

it("preserves escaped JSON pointers for invalid and missing argument keys", async () => {
	const record = local("keys", { version: 1, params: {}, members: {
		write: method(obj({ tags: map(str()), "must/~exist": str() })),
	} });
	const host = createHost({ onError() {} });
	try {
		await host.load([{ name: "keys", facet: defineFacet((facet) => facet.serve(record, () => ({ write: async () => null }))) }], context);
		const reference = await host.get(record, {}, context);
		await expect(reference.write({ tags: { "a/b": 4 }, "must/~exist": "yes" } as never, context))
			.rejects.toMatchObject({ details: { path: "/tags/a~1b" } });
		await expect(reference.write({ tags: {} } as never, context))
			.rejects.toMatchObject({ details: { path: "/must~1~0exist" } });
		reference.release();
	} finally { await host.close(context); }
});

it("refuses optional schemas outside properties while retaining optional object fields", () => {
	expect(() => local("optional", { version: 1, params: {}, members: { invalid: opt(str()) } })).toThrow("expected a schema");
	expect(() => local("valid", { version: 1, params: {}, members: { send: method(obj({ label: opt(str()) })) } })).not.toThrow();
});
