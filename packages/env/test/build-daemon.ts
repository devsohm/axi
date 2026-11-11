import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
	// Direct Vitest runs need the same current daemon as the complete verification command.
	execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-daemon.mjs", import.meta.url))], {
		stdio: "inherit",
	});
}
