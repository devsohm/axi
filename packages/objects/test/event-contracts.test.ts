import { expect, expectTypeOf, test } from "vitest";
import {
	bytes,
	event,
	evolve,
	hostKind,
	int,
	local,
	obj,
	remote,
	str,
	type EventMember,
	type Implementation,
} from "../src/contracts/index.ts";
import { checkAccepts, contractData, currentVariants } from "../src/contracts/internal.ts";

test("event declarations preserve plain-contract fingerprints and expose a separate read interface", () => {
	const Server = hostKind("events-server");
	const plain = remote("events-view", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { read: { state: { count: int() } } },
	});
	const empty = remote("events-view", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { read: { state: { count: int() }, events: {} } },
	});
	const changed = remote("events-view", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { read: { state: { count: int() }, events: { progress: str() } } },
	});
	expect(empty.fingerprint).toBe(plain.fingerprint);
	expect(changed.fingerprint).not.toBe(plain.fingerprint);
	const store = local("events-store", {
		version: 1,
		params: {},
		members: { count: int(), progress: event(obj({ text: str() })) },
	});
	const members = currentVariants(store).get("members")!;
	expect([...members.events.keys()]).toEqual(["progress"]);
	expect([...members.state.keys()]).toEqual(["count"]);
	expectTypeOf<Implementation<typeof store>["progress"]>().toEqualTypeOf<EventMember<{ text: string }>>();
});

test("event histories require mappings for edits, including identical schemas, and preserve retired kinds", () => {
	const initial = local("events-history", { version: 1, params: {}, members: { progress: event(int()) } });
	const edited = evolve(initial, (e) => e.event("progress", int()).addEvent("finished", str()));
	expect(() => checkAccepts(edited, { 1: {} } as never)).toThrow("events.progress: missing mapping");
	expect(checkAccepts(edited, { 1: { events: { progress: (value) => value } } }).versions).toEqual([
		{ version: 1, fingerprint: initial.fingerprint },
	]);
	expect(checkAccepts(edited, { 1: { events: { progress: "refuse" } } }).versions).toHaveLength(1);
	const removed = evolve(edited, (e) => e.removeEvent("progress"));
	expect(checkAccepts(removed, { 1: {} }).versions).toHaveLength(1);
	expect(() => evolve(removed, (e) => e.addState("progress", int()))).toThrow('"progress" is an event member');
	expect(contractData(initial).versions[0]!.variants.get("members")!.events.size).toBe(1);
});

test("event values reject byte schemas and member names retain one kind", () => {
	expect(() =>
		local("events-bytes", { version: 1, params: {}, members: { chunk: event(obj({ data: bytes() })) } }),
	).toThrow("JSON only");
	const Server = hostKind("event-policy");
	expect(() =>
		remote("events-policy", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: {
				a: { state: { progress: int() } },
				b: { events: { progress: int() } },
			},
		} as never),
	).toThrow("its kind never changes");
});
