import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { acceptHostKey } from "../src/ssh.ts";

const fault = vi.hoisted(() => ({ refuseRename: false }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		async rename(...args: Parameters<typeof fs.rename>) {
			if (fault.refuseRename) throw Object.assign(new Error("Replacement refused"), { code: "EACCES" });
			return fs.rename(...args);
		},
	};
});
afterEach(() => {
	fault.refuseRename = false;
});

test("failed known-host replacement retains the old file, removes staging files and permits retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "axi-known-host-atomic-"));
	const file = join(directory, "known_hosts");
	const target = { host: "fixture.invalid", hostKeyAlias: "fixture", knownHostsFile: file };
	try {
		await writeFile(file, "existing ssh-ed25519 AAAA\n");
		fault.refuseRename = true;
		await expect(acceptHostKey(target, ["fixture ssh-ed25519 AQID"])).rejects.toMatchObject({ code: "EACCES" });
		expect(await readFile(file, "utf8")).toBe("existing ssh-ed25519 AAAA\n");
		expect(await readdir(directory)).toEqual(["known_hosts"]);
		fault.refuseRename = false;
		await acceptHostKey(target, ["fixture ssh-ed25519 AQID"]);
		expect(await readFile(file, "utf8")).toBe("existing ssh-ed25519 AAAA\nfixture ssh-ed25519 AQID\n");
		expect(await readdir(directory)).toEqual(["known_hosts"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
