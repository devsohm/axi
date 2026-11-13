import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { int, local, method } from "../src/contracts/index.ts";
import { currentVariants } from "../src/contracts/internal.ts";
import { ObjectsError } from "../src/data/index.ts";
import { type Message, wireError } from "../src/link/internal.ts";
import { ConsumerSide } from "../src/remote/consumer.ts";
import type { HostLink } from "../src/remote/host-link.ts";
import type { RemoteObject } from "../src/remote/remote-object.ts";
import { OldWork } from "../src/host/old-work.ts";

it("rejects waiting calls when their provider fails without sending them after an active call ends", async () => {
	const contract = local("tests.waiting-calls", {
		version: 1,
		params: {},
		members: { run: method(int(), int()) },
	});
	const data = currentVariants(contract).values().next().value!.methods.get("run")!;
	const messages: Message[] = [];
	const link = {
		host: { oldWork: new OldWork() },
		role: "parent",
		context,
		limits: { part: Infinity, decoded: Infinity },
		inflates() {
			return false;
		},
		send(message: Message) {
			messages.push(message);
		},
	} as unknown as HostLink;
	const failed = vi.fn();
	const consumer = new ConsumerSide(link);
	const hold = consumer.attach({ request: {}, caller: {}, failed } as unknown as RemoteObject, undefined);
	consumer.opened(1);
	const owner = {};
	const active = consumer.call(hold, 0, data, 1, owner, context);
	let waiting: unknown = "pending";
	const queued = consumer.call(hold, 0, data, 2, owner, context).catch((error) => {
		waiting = error;
	});
	try {
		consumer.message({
			kind: "failed",
			hold,
			cause: {
				kind: "broken",
				error: wireError(new ObjectsError({ code: "unavailable", message: "provider unavailable" })),
			},
		});
		await Promise.resolve();
		expect(waiting).toMatchObject({ code: "unavailable", message: "provider unavailable" });
		expect(failed).toHaveBeenCalledOnce();
		consumer.message({ kind: "result", call: 0 });
		expect(await active).toBeNull();
		expect(messages.filter((message) => message.kind === "call")).toHaveLength(1);
	} finally {
		consumer.closed();
		await Promise.allSettled([active, queued]);
	}
});
