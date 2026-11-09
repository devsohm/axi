import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { bytes, createHost, defineFacet, int, lit, local, map, method, obj, opt, str, union } from "../src/index.ts";
import { bindProvider, checkArgs } from "../src/data/args.ts";

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
			["x", "expected bytes, got string"],
			["longer", "expected bytes, got string"],
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

it("reports declaration constraints before unknown fields and selects the relevant union branch", async () => {
	const contract = local("settings", { version: 1, params: {}, members: {
		write: method(obj({ label: str({ min: 3 }), count: int({ min: 2 }) })),
		choose: method(union([obj({ title: str() }), obj({ count: int() })])),
		tagged: method(union([obj({ kind: lit("a"), title: str() }), obj({ kind: lit("b"), count: int() })])),
		tie: method(union([obj({ field: int(), veryLongMissingField: str() }), obj({ field: str() })])),
	} });
	const host = createHost({ onError() {} });
	try {
		await host.load([{ name: "settings", facet: defineFacet(facet => facet.serve(contract, () => ({ write: async () => null, choose: async () => null, tagged: async () => null, tie: async () => null }))) }], context);
		const ref = await host.get(contract, {}, context);
		await expect(ref.write({ label: "ok", count: 2 } as never, context)).rejects.toThrow("args/label: expected at least 3 characters");
		await expect(ref.write({ label: "valid", count: 1 } as never, context)).rejects.toThrow("args/count: expected >= 2");
		await expect(ref.write({ label: 2, count: 2, extra: true } as never, context)).rejects.toThrow("args/label: expected string, got integer");
		await expect(ref.choose({ count: "bad" } as never, context)).rejects.toThrow("args/count: expected integer, got string");
		await expect(ref.tagged({ kind: "unknown", count: 1 } as never, context)).rejects.toThrow('args/kind: expected one of ["a","b"]');
		await expect(ref.tagged({ kind: "a", count: 1 } as never, context)).rejects.toThrow("args/title: missing");
		await expect(ref.tie({ field: [] } as never, context)).rejects.toThrow("args/veryLongMissingField: missing");
		ref.release();
	} finally { await host.close(context); }
});

it("resolves fragment references in their schema resource and refuses a missing target", () => {
	for (const named of [false, true]) {
		const schema = { type: "object", properties: { value: { $ref: "#/$defs/count" } }, required: ["value"],
			additionalProperties: false, $defs: { count: { type: "integer" } }, ...(named ? { $id: "urn:settings" } : {}) };
		const contract = local("reference", { version: 1, params: {}, members: { write: method(schema) } });
		const bound = bindProvider(contract, {});
		expect(() => checkArgs(bound, "write", { value: 1 }, 1, context)).not.toThrow();
		expect(() => checkArgs(bound, "write", { value: "bad" }, 1, context)).toThrow("expected integer, got string");
	}
	const invalid = local("invalid", { version: 1, params: {}, members: {
		write: method(obj({ value: { $defs: { count: { type: "integer" } }, $ref: "#/$defs/count" } })),
	} });
	expect(() => checkArgs(bindProvider(invalid, {}), "write", { value: 1 }, 1, context))
		.toThrow("Unresolved $ref #/$defs/count in https://json-schema.invalid/root.json");
});

it("reports an invalid union through nested references without losing its schema", () => {
	const contract = local("nested", { version: 1, params: {}, members: { write: method({
		type: "object", $defs: { choice: { anyOf: [{ type: "number" }, { type: "boolean" }] },
			container: { type: "object", properties: { nested: { $ref: "#/$defs/choice" } }, required: ["nested"], additionalProperties: false } },
		properties: { value: { $ref: "#/$defs/container" } }, required: ["value"], additionalProperties: false,
	}) } });
	const bound = bindProvider(contract, {});
	expect(() => checkArgs(bound, "write", { value: { nested: {} } }, 1, context)).toThrow("args/value/nested: expected number, got object");
	expect(() => checkArgs(bound, "write", { value: { nested: 2 } }, 1, context)).not.toThrow();
	const choose = local("choose", { version: 1, params: {}, members: { write: method({
		type: "object", $defs: { left: { type: "object", properties: { x: { type: "string" } }, required: ["x"], additionalProperties: false },
			right: { type: "object", properties: { y: { type: "integer" } }, required: ["y"], additionalProperties: false } },
		properties: { value: { anyOf: [{ $ref: "#/$defs/left" }, { $ref: "#/$defs/right" }] } }, required: ["value"], additionalProperties: false,
	}) } });
	expect(() => checkArgs(bindProvider(choose, {}), "write", { value: { y: "bad" } }, 1, context))
		.toThrow("args/value/y: expected integer, got string");
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
