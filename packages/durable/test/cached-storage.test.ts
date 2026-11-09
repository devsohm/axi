import { BACKGROUND_CONTEXT } from "@axi/objects/context";
import { expect, it } from "vitest";
import { CachedStorage } from "../src/session/cached-storage.ts";
import { MemoryStorage } from "../src/storage/memory.ts";

it("forwards publication to the backend's current scope with its receiver", () => {
	class ScopedStorage extends MemoryStorage {
		publishing(publish: () => void) {
			publish();
		}
	}
	const storage = new ScopedStorage();
	const cached = new CachedStorage(storage);
	const forward = cached.publishing;
	const calls: unknown[] = [];
	storage.publishing = function (publish) {
		calls.push(this === storage);
		publish();
	};
	forward?.(() => calls.push("published"), BACKGROUND_CONTEXT);
	expect(calls).toEqual([true, "published"]);
});
