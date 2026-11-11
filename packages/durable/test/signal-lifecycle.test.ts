import { createModels } from "@axi/ai";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { createRegistry, defineSignal, Harness, MemoryStorage, type SignalResult, type TaskId } from "../src/index.ts";

test.each(["closed", "read-only"] as const)(
	"signal delivery on a %s harness returns a rejected promise",
	async (state) => {
		const storage = new MemoryStorage();
		const id = await storage.mintId<TaskId>();
		const token = defineSignal({ name: "lifecycle-reply", version: 1, schema: Type.String() });
		const harness = await Harness.open(
			storage,
			{ models: createModels(), registry: createRegistry(), readOnly: state === "read-only" },
			context,
		);
		if (state === "closed") await harness.close(context);
		try {
			let pending: Promise<SignalResult> | undefined;
			expect(() => {
				pending = harness.signal(id, token, "reply", "answer", context);
			}).not.toThrow();
			expect(pending).toBeInstanceOf(Promise);
			await expect(pending).rejects.toThrow(state === "closed" ? /closed/ : /Read-only Harness/);
			if (state === "read-only") expect((await harness.inspect(context)).scheduling).toBe("paused");
		} finally {
			await harness.close(context);
		}
	},
);
