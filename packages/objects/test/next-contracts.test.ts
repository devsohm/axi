import { expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { local, remote, hostKind, method, obj, str, int, bytes, map, evolve, keyed, type Implementation } from "../src/next/contracts/index.ts";
import { contractData, checkAccepts, snapshotArguments } from "../src/next/contracts/internal.ts";
import type { Increment } from "../src/next/contracts/history.ts";
import { bindProvider, binds, checkArgs, checkParams, principalKey, canonicalJson, check, validatorFor, objectsErrorFromJson, waitingFor } from "../src/next/data/internal.ts";
import { ObjectsError } from "../src/next/data/index.ts";
import { createHost, defineFacet } from "../src/next/host/index.ts";
import { nodeCompression } from "../src/next-node/compression.ts";
import { DeflatedPart, inflateAsync, openPart, originPart, oversized } from "../src/next/link/part.ts";
import { compareText, prefixUpperBound, storedText } from "../src/next/store/text.ts";

it("evolves keyed document schemas without mutating older versions and requires direct mappings", () => {
	const original = local("drafts", { version: 1, params: {}, members: { items: keyed(obj({ text: str() })) } });
	const current = evolve(original, editor => editor.keyed("items", obj({ text: str(), revision: int() })).addKeyed("scratch", str()));
	const last = evolve(current, editor => editor.removeKeyed("scratch"));
	expect(contractData(last).versions.map(version => [...version.variants.get("members")!.keyed.keys()])).toEqual([
		["items"], ["items", "scratch"], ["items"],
	]);
	expect(checkAccepts(last, { 1: { keyed: { items: value => ({ text: value.text }) } } }).versions).toEqual([
		{ version: 1, fingerprint: original.fingerprint },
	]);
	expect(contractData(original).versions).toHaveLength(1);
});

it("validates an old caller, maps directly to the current method, and maps its result back", () => {
	const Workspace = hostKind("workspace", { name: str() });
	const original = remote("counter", { version: 9, params: { workspace: str() },
		hostAddress: ({ workspace }) => Workspace({ name: workspace }),
		variants: { owner: { methods: { increment: method(obj({ amount: int() }), int()) } } } });
	const current = evolve(original, (e) => e.args("increment", obj({ amount: int(), unit: str() })).result("increment", str()));
	const bound = bindProvider(current, { 9: { methods: { increment: {
		args: ({ amount }) => ({ amount, unit: "items" }), result: (value) => Number(value),
	} } } });
	const call = checkArgs(bound, "increment", { amount: 4 }, 9, context);
	expect([
		binds(bound, current.version, current.fingerprint),
		binds(bound, original.version, original.fingerprint),
		binds(bound, original.version, current.fingerprint),
		binds(bound, 8, original.fingerprint),
	]).toEqual([true, true, false, false]);
	expect(current.version).toBe(10);
	expectTypeOf<Increment<"999">>().toEqualTypeOf<"1000">();
	expectTypeOf<Implementation<typeof current>["variant"]>().toEqualTypeOf<"owner">();
	expect(call.kind).toBe("method");
	if (call.kind !== "method") throw new Error("Expected a mapped method");
	expect(call.args).toEqual({ amount: 4, unit: "items" });
	expect(call.result?.("12")).toBe(12);
	expect(() => checkArgs(bound, "increment", { amount: 4, unit: "items" }, 9, context)).toThrow("args/unit: unknown field");
	const params = { workspace: "a|b" };
	expect(checkParams(current, params, context)).toEqual({ params, key: "a\\|b" });
	expect(checkParams(current, params, context).params).toBe(params);
	expect(contractData(original).versions).toHaveLength(1);
});

it("captures a provider's argument and result adapters when it binds", async () => {
	const original = local("adapters", { version: 1, params: {}, members: { echo: method(int(), int()) } });
	const current = evolve(original, editor => editor.method("echo", str(), str()));
	const mapping = { args: (value: number) => String(value), result: (value: string) => Number(value) + 1 };
	const host = createHost({ onError(error) { throw error }, readyTimeout: 100 });
	try {
		await host.load([{ name: "adapters", facet: defineFacet(h => h.serve(current, () => ({ echo: async value => value }), {
			accepts: { 1: { methods: { echo: mapping } } },
		})) }], context);
		const reference = await host.get(original, {}, context);
		expect(await reference.echo(3, context)).toBe(4);
		mapping.args = value => String(value + 100);
		mapping.result = value => Number(value) + 1000;
		expect(await reference.echo(3, context)).toBe(4);
	} finally { await host.close(context) }
});

it("keeps schema snapshots and rejects missing version mappings even for a repeated schema", () => {
	const schema = obj({ text: str() });
	const original = local("notes", { version: 1, params: {}, members: { save: method(schema), count: int() } });
	Object.assign(schema.properties.text, { minLength: 20 });
	expect(checkArgs(bindProvider(original, {}), "save", { text: "short" }, 1, context).args).toEqual({ text: "short" });
	const changed = evolve(original, (e) => e.state("count", int()));
	expect(() => checkAccepts(changed, { 1: {} } as never)).toThrow("notes accepts[1].state.count: missing mapping");
	expect(() => contractData({ ...original })).toThrow("not a declared contract");
	const payload = snapshotArguments(obj({ chunks: map(bytes({ max: 2 })) }), "upload");
	const validator = validatorFor(payload, context);
	expect(() => check(validator, { chunks: { "a/b~1": new Uint8Array(3) } }, "args", context)).toThrow("args/chunks/a/b~1: expected bytes");
});

it("preserves protocol error fields and bounded dependency messages", () => {
	const details = { operation: "open" };
	const error = objectsErrorFromJson({ code: "unavailable", reason: "undeclared", message: "catalog missing", details });
	expect(error.details).toBe(details);
	expect(JSON.parse(JSON.stringify(error))).toEqual({ code: "unavailable", reason: "undeclared", message: "catalog missing", details });
	for (const code of ["__proto__", "constructor"]) expect(() => objectsErrorFromJson({ code, message: "bad" })).toThrow("unknown code");
	expect(waitingFor("panel", waitingFor("chat", error).error).error.message).toBe("waiting for panel: catalog missing");
	expect(waitingFor("x".repeat(600), new ObjectsError({ code: "gone", message: "y".repeat(600) })).error.message).toHaveLength(500);
	const principal = { kind: "user", "2": "b", "10": "a" };
	expect(canonicalJson(principal, context)).toBe('{"10":"a","2":"b","kind":"user"}');
	expect(principalKey(principal, context, (value) => value.kind)).toBe("user");
});

it("bounds compressed data before opening it, and cancels asynchronous inflation", async () => {
	const value = JSON.stringify({ text: "界".repeat(15000) });
	const part = originPart(value, nodeCompression, context);
	expect(part).toBeInstanceOf(DeflatedPart);
	expect(new TextDecoder().decode(openPart(part, { part: 1000, decoded: 50000 }, nodeCompression, context) as Uint8Array)).toBe(value);
	expect(() => openPart(part, { part: 1000, decoded: 10 }, nodeCompression, context)).toThrow("decoded limit");
	expect(oversized("é😀", 5)?.code).toBe("too_large");
	const cancelled = new DeflatedPart(nodeCompression.deflate(new Uint8Array(100000)));
	const controller = new AbortController();
	const inflating = inflateAsync(cancelled, Infinity, controller.signal, context);
	controller.abort();
	await inflating;
	expect(cancelled.inflated).toBeUndefined();
});

it("orders stored text by code point and constructs a bounded prefix range", () => {
	expect(["😀", "\uE000", "a"].sort(compareText)).toEqual(["a", "\uE000", "😀"]);
	expect(prefixUpperBound("a\u{10FFFF}")).toBe("b");
	expect(storedText("a\uD800", "path")).toBe("a�");
	expect(() => storedText("a\0b", "path")).toThrow("text may not contain NUL");
});
