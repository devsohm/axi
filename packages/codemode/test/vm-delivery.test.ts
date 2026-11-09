import { expect, test } from "vitest";
import { loadQuickJSWasm } from "../src/wasm.ts";
import { startVm } from "../src/runtime/vm.ts";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../src/runtime/protocol.ts";

async function fixture(code: string, deterministic = true) {
	const messages: WorkerToHostMessage[] = [];
	const vm = await startVm({
		wasm: await loadQuickJSWasm(),
		shouldInterrupt: () => false,
		post: (message) => messages.push(message),
		data: {
			code,
			tools: ["one", "two", "tick"].map((name) => ({ name, jsName: name, description: name })),
			globals: [],
			store: {},
			memoryLimitBytes: undefined,
			...(deterministic ? { deterministic: { startedAt: 100, seed: 7 } } : {}),
		},
	});
	const call = (name: string, index = 0) => {
		const message = messages.filter((message) => message.type === "call" && message.name === name)[index];
		if (message?.type !== "call") throw new Error(`Missing host call ${name}`);
		return message;
	};
	return { vm, messages, call };
}

test("deterministic host replies are applied in sequence even when received out of order", async () => {
	const { vm, messages, call } = await fixture(
		"const a=tools.one(); const b=tools.two(); return [await a,await b,Date.now()];",
	);
	try {
		vm.deliver({ type: "result", id: call("two").id, ok: true, payload: "22", seq: 2, now: 250 });
		expect(messages.some((message) => message.type === "done")).toBe(false);
		vm.deliver({ type: "result", id: call("one").id, ok: true, payload: "11", seq: 1, now: 200 });
		expect(messages.find((message) => message.type === "done")).toMatchObject({
			type: "done",
			ok: true,
			value: "[11,22,250]",
			during: { seq: 2, issued: 2 },
		});
		expect(messages.flatMap((message) => (message.type === "idle" ? [message.seq] : []))).toEqual([0, 1, 2]);
	} finally {
		vm.dispose();
	}
});

test.each([undefined, 0, -1, 1.5, NaN])(
	"an invalid deterministic sequence %s fails before the waiting script observes a result",
	async (seq) => {
		const { vm, messages, call } = await fixture("return await tools.one();");
		try {
			vm.deliver({
				type: "result",
				id: call("one").id,
				ok: true,
				payload: "42",
				...(seq === undefined ? {} : { seq }),
			});
			expect(messages.filter((message) => message.type === "crash")).toMatchObject([
				{ message: expect.stringContaining("sequence number") },
			]);
			expect(messages.some((message) => message.type === "done")).toBe(false);
		} finally {
			vm.dispose();
		}
	},
);

test.each(["queued", "delivered"] as const)("a %s sequence cannot be reused", async (state) => {
	const { vm, messages, call } = await fixture("const a=tools.one(); const b=tools.two(); return [await a,await b];");
	try {
		const reply: HostToWorkerMessage = {
			type: "result",
			id: call(state === "queued" ? "two" : "one").id,
			ok: true,
			payload: "7",
			seq: state === "queued" ? 2 : 1,
		};
		vm.deliver(reply);
		vm.deliver(reply);
		expect(messages.filter((message) => message.type === "crash")).toMatchObject([
			{ message: expect.stringContaining("once") },
		]);
		expect(messages.some((message) => message.type === "done")).toBe(false);
	} finally {
		vm.dispose();
	}
});

test("logical time never moves backward and ignores non-finite host timestamps", async () => {
	const { vm, messages, call } = await fixture(
		"const times=[]; for(let i=0;i<3;i++){await tools.tick();times.push(Date.now());} return times;",
	);
	try {
		for (const [index, now] of [0, NaN, 150].entries())
			vm.deliver({ type: "result", id: call("tick", index).id, ok: true, payload: undefined, seq: index + 1, now });
		expect(messages.find((message) => message.type === "done")).toMatchObject({
			type: "done",
			ok: true,
			value: "[100,100,150]",
		});
	} finally {
		vm.dispose();
	}
});

test("failed host replies expose structured properties to script error handling", async () => {
	const { vm, messages, call } = await fixture(
		"try {await tools.one();} catch(error) {return [error.message,error.category,Date.now()];}",
	);
	try {
		vm.deliver({
			type: "result",
			id: call("one").id,
			ok: false,
			payload: "Quota exceeded",
			properties: '{"category":"quota"}',
			seq: 1,
			now: 125,
		});
		expect(messages.find((message) => message.type === "done")).toMatchObject({
			type: "done",
			ok: true,
			value: '["Quota exceeded","quota",125]',
		});
	} finally {
		vm.dispose();
	}
});

test("ordinary replies need no replay sequence and disposal prevents any later delivery", async () => {
	const { vm, messages, call } = await fixture("return await tools.one();", false);
	try {
		vm.deliver({ type: "result", id: call("one").id, ok: true, payload: "42" });
		expect(messages.find((message) => message.type === "done")).toMatchObject({ type: "done", ok: true, value: "42" });
		vm.dispose();
		vm.dispose();
		const count = messages.length;
		vm.deliver({ type: "result", id: 100, ok: true, payload: "99" });
		expect(messages).toHaveLength(count);
	} finally {
		vm.dispose();
	}
});
