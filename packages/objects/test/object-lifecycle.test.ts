import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { createHost, defineRegistry, local, method, type Ctx, type Facet } from "../src/index.ts";

const Counter = local("lifecycle-counter", {
	version: 1,
	input: Type.Object({}),
	members: { value: Type.Number(), set: method(Type.Number(), Type.Number()) },
});

test("activation opens resource dependencies before state initialization and closes in reverse order", async () => {
	const events: string[] = [],
		gate = Promise.withResolvers<void>(),
		opened = Promise.withResolvers<void>();
	const host = createHost({ self: null });
	host.serve(Counter, (_input, _principal, self) => {
		const first = self.resource("first", {
			version: 1,
			async open() {
				events.push("first opened");
				opened.resolve();
				await gate.promise;
				return 12;
			},
			close(value) {
				events.push(`first closed ${value}`);
			},
		});
		const second = self.resource("second", {
			version: 1,
			deps: [first],
			open() {
				events.push("second opened");
				return first.value + 3;
			},
			close(value) {
				events.push(`second closed ${value}`);
			},
		});
		const value = self.state("value", Type.Number(), {
			async init() {
				events.push("initialized");
				return second.value;
			},
		});
		return {
			value,
			set(next: number, ctx: Ctx) {
				value.replace(ctx, next);
				return value.value;
			},
		};
	});
	const ref = host.hold(Counter, {});
	try {
		await opened.promise;
		expect(ref.status).toBe("loading");
		expect(() => ref.value.value).toThrow(/not_ready/);
		gate.resolve();
		await ref.ready;
		expect(ref.value.value).toBe(15);
		expect(await ref.set(20)).toBe(20);
		ref.release();
		await vi.waitFor(() =>
			expect(events).toEqual(["first opened", "second opened", "initialized", "second closed 15", "first closed 12"]),
		);
		await expect(ref.set(1)).rejects.toMatchObject({ code: "released" });
	} finally {
		gate.resolve();
		await host.close();
	}
});

test("failed activation closes acquired resources and a later acquisition can retry", async () => {
	const events: string[] = [];
	const host = createHost({ self: null, onError: () => {} });
	let fail = true;
	host.serve(Counter, (_input, _principal, self) => {
		const first = self.resource("first", {
			version: 1,
			open() {
				events.push("opened");
				return 1;
			},
			close() {
				events.push("closed");
			},
		});
		self.resource("second", {
			version: 1,
			deps: [first],
			open() {
				if (fail) throw new Error("second resource offline");
				return 2;
			},
		});
		const value = self.state("value", Type.Number(), 8);
		return {
			value,
			set(next: number, ctx: Ctx) {
				value.replace(ctx, next);
				return value.value;
			},
		};
	});
	try {
		const ref = host.hold(Counter, {});
		await expect(ref.ready).rejects.toThrow("second resource offline");
		await vi.waitFor(() => expect(events).toEqual(["opened", "closed"]));
		expect(ref.status).toBe("gone");
		fail = false;
		const retried = await host.get(Counter, {});
		expect(await retried.set(9)).toBe(9);
		expect(events).toEqual(["opened", "closed", "opened"]);
		retried.release();
		await vi.waitFor(() => expect(events).toEqual(["opened", "closed", "opened", "closed"]));
	} finally {
		await host.close();
	}
});

test("listeners use fresh roots and object disposal stops subscriptions and background tasks", async () => {
	const listeners = new Set<(value: number) => void>(),
		roots: string[] = [],
		stopped = Promise.withResolvers<void>(),
		started = Promise.withResolvers<void>();
	const host = createHost({ self: null });
	host.serve(Counter, (_input, _principal, self) => {
		const value = self.state("value", Type.Number(), 0);
		const source = self.resource("events", {
			version: 1,
			open: () => ({
				subscribe(listener: (value: number) => void) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			}),
		});
		self.on(
			"events",
			source,
			(events) => events,
			(amount, ctx) => {
				roots.push(ctx.rootId);
				value.change(ctx, (before) => before + amount);
			},
		);
		self.task(async (ctx) => {
			started.resolve();
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) resolve();
				else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			stopped.resolve();
		});
		return {
			value,
			set(next: number, ctx: Ctx) {
				value.replace(ctx, next);
				return value.value;
			},
		};
	});
	try {
		const ref = await host.get(Counter, {});
		await started.promise;
		for (const amount of [4, 7]) for (const notify of listeners) notify(amount);
		await vi.waitFor(() => expect(ref.value.value).toBe(11));
		expect(roots).toHaveLength(2);
		expect(new Set(roots).size).toBe(2);
		ref.release();
		await stopped.promise;
		await vi.waitFor(() => expect(listeners.size).toBe(0));
	} finally {
		await host.close();
	}
});

test("state migration resets subscribers and rejects a later version downgrade atomically", async () => {
	const migrated: { old: unknown; from: number }[] = [];
	function facet(version: number): Facet {
		return {
			name: "counter-module",
			setup(api) {
				api.serve(Counter, (_input, _principal, self) => {
					const value = self.state("value", Type.Number(), 1, {
						version,
						migrate(old, from) {
							if (typeof old !== "number") throw new Error("Expected number");
							migrated.push({ old, from });
							return old + 10;
						},
					});
					return {
						value,
						set(next: number, ctx: Ctx) {
							value.replace(ctx, next);
							return value.value;
						},
					};
				});
			},
		};
	}
	const host = createHost({ self: null, onError: () => {} });
	try {
		await host.install(facet(1));
		const ref = await host.get(Counter, {});
		const frames: string[] = [];
		const values: number[] = [];
		ref.value.events((event) => {
			frames.push(event.type);
			values.push(event.value);
		});
		expect(await ref.set(4)).toBe(4);
		await host.reload([facet(2)]);
		expect(ref.value.value).toBe(14);
		expect(migrated).toEqual([{ old: 4, from: 1 }]);
		expect(frames).toEqual(["snap", "ops", "reset"]);
		expect(values).toEqual([1, 4, 14]);
		await expect(host.reload([facet(1)])).rejects.toThrow(/version/);
		expect(ref.value.value).toBe(14);
		expect(await ref.set(16)).toBe(16);
	} finally {
		await host.close();
	}
});

test("derived state rebinds its listener after reload without losing the source value", async () => {
	const observed: number[] = [];
	const host = createHost({ self: null });
	function facet(): Facet {
		return {
			name: "derived-counter",
			setup(api) {
				api.serve(
					Counter,
					(_input, _principal, self) => {
						const value = self.state("value", Type.Number(), 2),
							derived = self.derive([value], (n) => n * 3);
						self.on("derived", derived, (n) => {
							observed.push(n);
						});
						return {
							value,
							set(next: number, ctx: Ctx) {
								value.replace(ctx, next);
								return value.value;
							},
						};
					},
					{ lifetime: "host" },
				);
			},
		};
	}
	try {
		await host.install(facet());
		const ref = await host.get(Counter, {});
		await vi.waitFor(() => expect(observed).toEqual([6]));
		expect(await ref.set(5)).toBe(5);
		await vi.waitFor(() => expect(observed).toEqual([6, 15]));
		await host.reload([facet()]);
		await vi.waitFor(() => expect(observed).toEqual([6, 15, 15]));
		expect(await ref.set(7)).toBe(7);
		await vi.waitFor(() => expect(observed).toEqual([6, 15, 15, 21]));
	} finally {
		await host.close();
	}
});

test("host-owned registrations follow reload and disappear when the declaring service is removed", async () => {
	const index = defineRegistry<string>("actions"),
		host = createHost({ self: null });
	const item = local("action-catalog", { version: 1, input: Type.Object({}), members: {} });
	const changes: string[][] = [];
	const view = host.registry(index),
		remove = view.subscribe((table) => changes.push([...table.values()]));
	const facet = (label: string): Facet => ({
		name: "actions",
		setup(api) {
			api.serve(
				item,
				(_input, _principal, self) => {
					self.register(index, { run: label });
					return {};
				},
				{ lifetime: "host" },
			);
		},
	});
	try {
		await host.install(facet("first"));
		expect(view.get("run")).toBe("first");
		const ref = await host.get(item, {});
		ref.release();
		expect(view.get("run")).toBe("first");
		await host.reload([facet("second")]);
		expect(view.get("run")).toBe("second");
		await host.reload([{ name: "actions", setup() {} }]);
		expect([...view.table()]).toEqual([]);
		expect(changes).toEqual([[], ["first"], ["second"], []]);
	} finally {
		remove();
		await host.close();
	}
});
