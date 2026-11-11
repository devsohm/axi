import { expect, test } from "vitest";
import { bool, hostKind, int, oneOf, str } from "../src/contracts/index.ts";
import { addressOfKey, keyOfAddress, kindOfKey } from "../src/contracts/host-kind.ts";

const Worker = hostKind("worker", { id: str() });
const Shard = hostKind("shard", { region: oneOf("east", "west"), partition: int({ min: 0 }) });
const Switch = hostKind("switch", { enabled: bool(), label: str() });
const Server = hostKind("server");

test.each(["", "plain", "a|b", "a\\b|c\\", "雪🙂"])("stored address keys round-trip escaped text: %j", (id) => {
	const address = Worker({ id });
	expect(keyOfAddress(Worker, address)).toBe(address.key);
	expect(addressOfKey(Worker, address.key)).toEqual(address);
	expect(kindOfKey(address.key)).toBe("worker");
});

test("decoding keeps numeric, boolean, enum, and empty parameter types", () => {
	const shard = Shard({ region: "west", partition: 23 });
	const enabled = Switch({ enabled: true, label: "switch|one" });
	const disabled = Switch({ enabled: false, label: "" });
	expect(addressOfKey(Shard, shard.key)).toEqual(shard);
	expect(addressOfKey(Switch, enabled.key)).toEqual(enabled);
	expect(addressOfKey(Switch, disabled.key)).toEqual(disabled);
	expect(addressOfKey(Server, "server")).toEqual(Server());
	expect(kindOfKey("server")).toBe("server");
});

test("address encoding derives identity from parameters rather than a supplied key", () => {
	expect(keyOfAddress(Worker, { ...Worker({ id: "actual" }), key: "worker|forged" })).toBe("worker|actual");
	for (const value of [
		null,
		undefined,
		"worker|actual",
		{},
		{ kind: "worker", params: null },
		{ kind: "worker", params: {} },
		{ kind: "worker", params: { id: 5 } },
		{ kind: "worker", params: { id: "actual", extra: "foreign" } },
		Server(),
	])
		expect(keyOfAddress(Worker, value)).toBeUndefined();
	expect(keyOfAddress(Shard, { kind: "shard", params: { region: "south", partition: 1 } })).toBeUndefined();
	expect(keyOfAddress(Shard, { kind: "shard", params: { region: "east", partition: 1.5 } })).toBeUndefined();
	expect(keyOfAddress(Switch, { kind: "switch", params: { enabled: "false", label: "" } })).toBeUndefined();
});

test("key conversion checks field types while routing remains responsible for other constraints", () => {
	expect(keyOfAddress(Shard, Shard({ region: "east", partition: -1 }))).toBe("shard|east|-1");
	expect(() => addressOfKey(Worker, "server")).toThrow("not an address key of worker");
	expect(() => addressOfKey(Worker, "worker|one|two")).toThrow("not an address key of worker");
	expect(() => keyOfAddress({ kind: "worker" }, Worker({ id: "one" }))).toThrow("not a declared host kind");
});
