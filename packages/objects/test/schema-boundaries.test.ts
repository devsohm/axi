import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { bytes, createHost, defineFacet, local, map, method, obj, opt, str } from "../src/index.ts";

it("keeps byte contracts as plain data while validating their values at invocation", async () => {
	const payload = bytes({ min: 2, max: 4 });
	expect(Reflect.ownKeys(payload)).toEqual(["type", "minLength", "maxLength"]);
	const contract = local("upload", { version: 1, params: {}, members: { send: method(obj({ payload })) } });
	const host = createHost({ onError() {} });
	try {
		await host.load([{ name: "upload", facet: defineFacet(facet => facet.serve(contract, () => ({ send: async () => null }))) }], context);
		const ref = await host.get(contract, {}, context);
		for (const [value, message] of [
			[[1, 2], "expected bytes, got array"],
			[new Uint8Array(1), "expected at least 2 bytes"],
			[new Uint8Array(5), "expected at most 4 bytes"],
		] as const) {
			await expect(ref.send({ payload: value } as never, context)).rejects.toMatchObject({
				message: `args/payload: ${message}`, details: { path: "/payload" },
			});
		}
		await expect(ref.send({ payload: new Uint8Array(3) }, context)).resolves.toBe(null);
		ref.release();
	} finally { await host.close(context); }
});

it("rejects hidden executable schema properties at their own path", () => {
	const schema = Object.defineProperty({ type: "string" }, "~refine", { value: [{ check: () => true }] });
	expect(() => local("hidden", { version: 1, params: {}, members: { value: schema } }))
		.toThrow("hidden.members.value.~refine: non-enumerable keys are not supported");
});

it("reports the received JSON type without applying format annotations", async () => {
	const contract = local("mail", { version: 1, params: {}, members: {
		send: method(obj({ address: { type: "string", format: "email" } })),
	} });
	const host = createHost({ onError() {} });
	try {
		await host.load([{ name: "mail", facet: defineFacet(facet => facet.serve(contract, () => ({ send: async () => null }))) }], context);
		const ref = await host.get(contract, {}, context);
		await expect(ref.send({ address: "local" }, context)).resolves.toBe(null);
		await expect(ref.send({ address: 9 } as never, context)).rejects.toMatchObject({
			message: "args/address: expected string, got integer", details: { path: "/address" },
		});
		ref.release();
	} finally { await host.close(context); }
});

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
