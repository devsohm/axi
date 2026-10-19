import { childControl } from "../../src/manager.ts";
import { ChordError } from "../../src/errors.ts";

const control = childControl();
try {
	await control.lock();
	const init = await control.init;
	if (process.connected) process.send?.({ fixture: init });
	if (process.env.TEST_CHILD_MODE === "fatal") {
		control.fatal(new ChordError("unavailable", "child declined startup", { reason: "fixture" }));
	} else if (process.env.TEST_CHILD_MODE !== "silent") {
		control.ready();
	}
	control.onShutdown(() => {
		if (process.env.TEST_CHILD_MODE !== "ignore") process.exit(0);
	});
} catch {
	process.exitCode = 1;
	process.disconnect?.();
}
