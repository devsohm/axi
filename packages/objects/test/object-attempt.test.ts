import { LiveQueries } from "../src/store/live-query.ts";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { int, local, method, obj } from "../src/contracts/index.ts";
import { ObjectsError } from "../src/data/index.ts";
import { bindProvider } from "../src/data/internal.ts";
import { defineState } from "../src/documents/index.ts";
import { Documents } from "../src/documents/internal.ts";
import { Attempt, type AttemptObject, type Self } from "../src/host/attempt.ts";
import { Binding } from "../src/host/reference.ts";
import { LOADING } from "../src/host/ref-state.ts";
import type { HostError } from "../src/host/report.ts";
import { OldWork } from "../src/host/old-work.ts";
import { RegistryRecord } from "../src/registries/internal.ts";
import { Batch } from "../src/state/internal.ts";
const counter = defineState("counter", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }) });
const type = local("app.counter", {
	version: 1,
	params: {},
	members: { counter: obj({ n: int() }), add: method(obj({ by: int() }), int()) },
});

function environment(factory: (self: Self) => unknown) {
	const errors: HostError[] = [],
		counts: unknown[] = [],
		registries = new Map<string, RegistryRecord>();
	const batch = new Batch((error) => {
		errors.push(error);
	}, undefined);
	const documents = new Documents({
		label: type.name,
		batch,
		context,
		store: undefined,
		fail(error) {
			throw error;
		},
	});
	const host = {
		oldWork: new OldWork(),
		spanHost: "client",
		batch,
		principal: { kind: "host" },
		incarnation: "host",
		timeouts: { ready: 100, close: 100 },
		store: undefined,
		report(error: HostError) {
			errors.push(error);
		},
		count(kind: string, delta: number) {
			counts.push([kind, delta]);
		},
		async acquire() {
			throw new Error("No dependency");
		},
		reference(contract: typeof type, _dependent: unknown, caller: { principal: undefined; incarnation: string }) {
			return new Binding(contract, batch, undefined, caller, 100);
		},
		bind() {
			throw new Error("No dependency");
		},
		registryRecord(name: string) {
			let record = registries.get(name);
			if (!record) {
				record = new RegistryRecord(name, batch, (error) => errors.push(error));
				registries.set(name, record);
			}
			return record;
		},
	};
	let attempt: Attempt;
	const object: AttemptObject = {
		kind: "local",
		stateFor: () => LOADING,
		waitAt: () => () => {},
		liveQueries: new LiveQueries(),
		label: type.name,
		documents,
		host,
		params: {},
		principal: undefined,
		served: {
			contract: type,
			provider: bindProvider(type, {}),
			kind: "local",
			hostLifetime: true,
			plugin: "app",
			factory: (_params, self) => factory(self),
		},
		state: LOADING,
		hydrated: false,
		lastFailure: undefined,
		activationId: undefined,
		heldOnLink: false,
		blocksFirstPass: true,
		lastValues: false,
		variant: undefined,
		hold() {},
		unhold() {},
		member(name) {
			return attempt.member(name);
		},
		keyedMember(name) {
			return attempt.keyedMember(name);
		},
		async pinKey() {
			throw new Error("No keyed members");
		},
		pathTo() {
			return undefined;
		},
		retry() {},
		call(method, args, context, caller) {
			return attempt.call(method, args, context, caller);
		},
		claimDocuments() {},
		claimTable() {},
		jobRecords() {
			throw new Error("No jobs declared");
		},
		failLive(_attempt, cause) {
			errors.push({ kind: "object_failed", object: type.name, failure: cause });
		},
		retryOn() {},
		assertNoCycle() {},
		waitsFor() {},
		parked() {},
		unparked() {},
		dependencyMoved() {
			attempt.dependencyMoved();
		},
		ended() {
			return new ObjectsError({ code: "released", reason: "ended", message: `${type.name}: ended` });
		},
	};
	attempt = new Attempt(object, context);
	return {
		attempt,
		documents,
		errors,
		counts,
		async close() {
			attempt.seal(object.ended());
			const failures = await attempt.close({ kind: "close" });
			attempt.detach();
			attempt.releaseReferences();
			documents.end();
			return failures;
		},
	};
}

it("activates declared resources and state, validates method inputs and stamps local calls with host identity", async () => {
	const observed: unknown[] = [];
	const app = environment((self) => {
		const document = self.state(counter),
			resource = self.open(
				async () => "ready",
				() => {
					observed.push("closed");
				},
			);
		return {
			counter: document,
			add: async ({ by }: { by: number }, ctx: { principal: unknown; incarnation: string }) => {
				observed.push([resource.value, ctx.principal, ctx.incarnation]);
				return self.tx(async (tx) => {
					const draft = await tx.draft(document);
					draft.n += by;
					return draft.n;
				}, context);
			},
		};
	});
	try {
		expect(await app.attempt.activate(undefined)).toEqual({ kind: "live" });
		app.attempt.live();
		expect(
			await app.attempt.call("add", { by: 2 }, context, { principal: { kind: "visitor" }, incarnation: "visitor" }),
		).toBe(2);
		expect(app.attempt.member("counter").value).toEqual({ n: 2 });
		await expect(
			app.attempt.call("add", { by: "bad" }, context, { principal: undefined, incarnation: "other" }),
		).rejects.toMatchObject({ code: "invalid", reason: "args" });
		expect(observed).toEqual([["ready", { kind: "host" }, "host"]]);
		expect(app.counts).toEqual([
			["calls", 1],
			["calls", -1],
		]);
	} finally {
		expect(await app.close()).toEqual([]);
	}
	expect(observed.at(-1)).toBe("closed");
	expect(app.errors).toEqual([]);
});

it("closes resources in reverse declaration order and preserves close failures", async () => {
	const events: number[] = [],
		failure = new Error("close failed");
	let captured: Self | undefined;
	const app = environment((self) => {
		captured = self;
		self.open(
			async () => 1,
			(value) => {
				events.push(value);
			},
		);
		self.open(
			async () => 2,
			(value) => {
				events.push(value);
				throw failure;
			},
		);
		return { counter: self.state(counter), add: async () => 0 };
	});
	expect(await app.attempt.activate(undefined)).toEqual({ kind: "live" });
	app.attempt.live();
	expect(() => captured?.state(counter)).toThrow("valid only in the factory");
	expect(await app.close()).toEqual([
		{ kind: "close_failed", object: type.name, native: { kind: "native", position: 2 }, error: failure },
	]);
	expect(events).toEqual([2, 1]);
});
