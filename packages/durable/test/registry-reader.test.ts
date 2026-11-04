import { expect, it } from "vitest";
import { NativeWatch } from "@axi/objects";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import type { NativeObserver, RegistryValue } from "@axi/objects/next";
import { createRegistry, defineExtension, registryReader, type RegistrySnapshot } from "../src/index.ts";

it("reads composed snapshots and wakes subscribers synchronously only for values", () => {
	const registry = createRegistry();
	let observer: NativeObserver<RegistrySnapshot> | undefined;
	const source: RegistryValue<RegistrySnapshot> = {
		get value() { return registry.snapshot(); },
		async watch() { return new NativeWatch(registry.snapshot(), () => {}, () => {}); },
		observe(target, receivedContext) {
			expect(receivedContext).toBe(context);
			observer = target;
			return { value: registry.snapshot(), detach() { observer = undefined; } };
		},
	};
	const reader = registryReader(source, context), seen: string[][] = [];
	const detach = reader.subscribe(() => seen.push(reader.snapshot().installed().map((extension) => extension.name)));
	registry.install(defineExtension({ name: "first" }));
	observer!.advance({ kind: "value", value: registry.snapshot() }, context);
	expect(seen).toEqual([["first"]]);
	observer!.advance({ kind: "failed", error: new Error("composition failed") }, context);
	expect(seen).toEqual([["first"]]);
	expect(reader.snapshot()).toBe(registry.snapshot());
	detach();
	expect(observer).toBeUndefined();
});
