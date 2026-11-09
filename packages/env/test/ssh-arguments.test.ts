import { expect, test } from "vitest";
import { sshArguments, type SshTarget } from "../src/ssh.ts";

const target: SshTarget = {
	host: "host.example.test",
	hostKeyAlias: "project-key",
	knownHostsFile: "/known hosts/100%.txt",
};

test("SSH arguments preserve explicit configuration and quote percent-bearing file paths", () => {
	const args = sshArguments(
		{ ...target, user: "developer", port: 65535, identityFile: "/private keys/100%.key", configFile: "/ssh config" },
		false,
	);
	expect(args.slice(0, 5)).toEqual(["-F", "/ssh config", "-T", "-a", "-x"]);
	expect(args).toContain('UserKnownHostsFile="/known hosts/100%%.txt"');
	expect(args).toContain('IdentityFile="/private keys/100%%.key"');
	expect(args).toContain("StrictHostKeyChecking=accept-new");
	expect(args).toContain("IdentitiesOnly=yes");
	expect(args.slice(-10)).toEqual([
		"-l",
		"developer",
		"-p",
		"65535",
		"-o",
		'IdentityFile="/private keys/100%%.key"',
		"-o",
		"IdentitiesOnly=yes",
		"--",
		target.host,
	]);
	expect(sshArguments(target)).toContain("StrictHostKeyChecking=yes");
	expect(sshArguments(target)).not.toContain("-l");
});

test.each(["host", "hostKeyAlias", "user"] as const)("invalid %s is rejected before launching SSH", (field) => {
	for (const value of ["", "-option", "has space", "tab\tvalue", "line\nvalue", "control\x00value", "delete\x7fvalue"])
		expect(() => sshArguments({ ...target, [field]: value })).toThrow(/Invalid/);
});

test.each(["knownHostsFile", "identityFile"] as const)(
	"invalid %s is rejected before it can become an SSH option",
	(field) => {
		for (const value of ["", 'quote"path', "line\npath", "control\x00path", "delete\x7fpath"])
			expect(() => sshArguments({ ...target, [field]: value })).toThrow(/Invalid/);
	},
);

test("SSH accepts both port boundaries and rejects non-integer or out-of-range ports", () => {
	for (const port of [1, 65535]) expect(sshArguments({ ...target, port })).toContain(String(port));
	for (const port of [0, -1, 65536, 1.5, NaN, Infinity])
		expect(() => sshArguments({ ...target, port })).toThrow("Invalid port");
});
