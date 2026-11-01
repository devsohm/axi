import assert from "node:assert/strict";
import { test } from "vitest";
import { isLegacyWslBashPath } from "../src/env/node-shell.ts";

test("legacy launcher detection follows the configured Windows directory", () => {
	const original = process.env.SystemRoot;
	try {
		process.env.SystemRoot = "D:\\WinNT";
		assert.equal(isLegacyWslBashPath("d:/WinNT/System32/bash.exe"), true);
		assert.equal(isLegacyWslBashPath("D:\\WinNT\\Sysnative\\bash.exe"), true);
		assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe"), false);
		assert.equal(isLegacyWslBashPath("D:\\Git\\bin\\bash.exe"), false);
		process.env.SystemRoot = "relative";
		assert.equal(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe"), false);
		delete process.env.SystemRoot;
		assert.equal(isLegacyWslBashPath("C:/Windows/System32/../Sysnative/bash.exe"), true);
		assert.equal(isLegacyWslBashPath("C:/Git/bin/bash.exe"), false);
	} finally {
		if (original === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = original;
	}
});
