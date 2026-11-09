import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import {
	binaryCodec,
	constant,
	createHost,
	defineFacet,
	defineState,
	hostKind,
	int,
	memoryLinkPair,
	method,
	obj,
	remote,
	textCodec,
	type Codec,
	type HostError,
	type Link,
	type Message,
} from "../src/index.ts";

const Server = hostKind("wire-recovery.server");
const Counter = remote("wire-recovery.counter", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { ready: { state: { n: int(), stable: int() }, methods: { set: method(int(), int()) } } },
});
const State = defineState("wire-recovery.state", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 1 }) });
async function fixture(codec: Codec, transform: (message: Message) => Message) {
	const reports: HostError[] = [];
	const server = createHost({
		address: Server(),
		principal: { kind: "server" },
		onError: (error) => reports.push(error),
	});
	const client = createHost({ principal: { kind: "client" }, onError: (error) => reports.push(error) });
	await server.load(
		[
			{
				name: "counter",
				facet: defineFacet((h) =>
					h.serve(
						Counter,
						(_params, _principal, self) => {
							const state = self.state(State);
							return {
								variant: "ready",
								members: {
									n: self.derive([state], ([value]) => value.n),
									stable: constant(2),
									set: async (n, call) => {
										await state.change((draft) => {
											draft.n = n;
										}, call);
										return n;
									},
								},
							};
						},
						{ linger: 60000 },
					),
				),
			},
		],
		context,
	);
	await client.load([], context);
	const closed = Promise.withResolvers<void>();
	const connect = (alter: boolean) => {
		const [incoming, outgoing] = memoryLinkPair();
		const link: Link = {
			send: (bytes) => incoming.send(alter ? codec.encode(transform(codec.decode(bytes))) : bytes),
			onMessage: (listener) => incoming.onMessage(listener),
			close: () => incoming.close(),
			onClose: (listener) =>
				incoming.onClose(() => {
					closed.resolve();
					listener();
				}),
		};
		server.accept(link, { principal: { kind: "client" }, codec }, context);
		client.connect(outgoing, { principal: { kind: "server" }, codec }, context);
	};
	connect(true);
	const ref = client.hold(Counter, {}, context);
	return {
		ref,
		reports,
		closed,
		connect: () => connect(false),
		async [Symbol.asyncDispose]() {
			ref.release();
			await client.close(context);
			await server.close(context);
		},
	};
}

type BoundFault = "variant" | "member-range" | "duplicate" | "missing" | "duplicate-failure" | "state-before-bound";
function corruptBound(message: Extract<Message, { kind: "bound" }>, fault: BoundFault): Message {
	if (fault === "state-before-bound")
		return {
			kind: "state",
			origin: message.origin,
			holds: message.holds.map((entry) => ({ hold: entry.hold, members: [], failed: [], retired: [] })),
		};
	return {
		...message,
		holds: message.holds.map((entry) => {
			const first = entry.members[0];
			if (!first) throw new Error("The counter snapshot needs a state member");
			switch (fault) {
				case "variant":
					return { ...entry, variant: 99 };
				case "member-range":
					return { ...entry, members: [{ ...first, member: 99 }] };
				case "duplicate":
					return { ...entry, members: [...entry.members, first] };
				case "missing":
					return { ...entry, members: [] };
				case "duplicate-failure":
					return {
						...entry,
						failed: [
							{
								member: first.member,
								error: { kind: "objects", error: { code: "not_ready", message: "injected failure" } },
							},
						],
					};
			}
		}),
	};
}

for (const codec of [binaryCodec, textCodec]) {
	test.each([
		"variant",
		"member-range",
		"duplicate",
		"missing",
		"duplicate-failure",
		"state-before-bound",
	] satisfies BoundFault[])(
		`${codec.name} rejects a malformed binding (%s) and the held reference recovers on a clean connection`,
		async (fault) => {
			let altered = false;
			await using app = await fixture(codec, (message) => {
				if (message.kind !== "bound" || altered) return message;
				altered = true;
				return corruptBound(message, fault);
			});
			await app.closed.promise;
			expect(altered).toBe(true);
			expect(app.reports).toContainEqual(expect.objectContaining({ kind: "protocol_error", error: expect.any(Error) }));
			app.connect();
			await vi.waitFor(() => expect(app.ref.state.value.kind).toBe("live"));
			expect([app.ref.n.value, app.ref.stable.value]).toEqual([1, 2]);
			expect(await app.ref.set(7, context)).toBe(7);
			await vi.waitFor(() => expect(app.ref.n.value).toBe(7));
		},
	);

	test.each(["member-range", "duplicate", "double-retirement"] as const)(
		`${codec.name} rejects a malformed state (%s) before adopting any of its changes`,
		async (fault) => {
			let altered = false;
			await using app = await fixture(codec, (message) => {
				if (message.kind !== "state" || altered) return message;
				altered = true;
				return {
					...message,
					holds: message.holds.map((entry) => {
						const first = entry.members[0];
						if (!first) throw new Error("The update needs a state member");
						if (fault === "member-range") return { ...entry, members: [{ ...first, member: 99 }] };
						if (fault === "duplicate") return { ...entry, members: [first, first] };
						return { ...entry, retired: [first.member, first.member] };
					}),
				};
			});
			await vi.waitFor(() => expect(app.ref.state.value.kind).toBe("live"));
			const watch = await app.ref.n.watch(context),
				values = [watch.value];
			watch.start(async (update) => {
				if (update.kind === "value") values.push(update.value);
			});
			const result = Promise.allSettled([app.ref.set(9, context)]);
			await app.closed.promise;
			await result;
			expect(altered).toBe(true);
			expect(values).toEqual([1]);
			expect(app.reports).toContainEqual(expect.objectContaining({ kind: "protocol_error", error: expect.any(Error) }));
			app.connect();
			await vi.waitFor(() => expect(app.ref.state.value.kind).toBe("live"));
			await vi.waitFor(() => expect(values).toEqual([1, 9]));
			expect(app.ref.stable.value).toBe(2);
			await watch.stop();
		},
	);
}
