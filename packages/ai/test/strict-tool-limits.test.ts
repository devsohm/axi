import { afterEach, expect, test } from "vitest";
import {
	hasExceededStrictToolLimits,
	isStrictToolLimitErrorMessage,
	markStrictToolLimitsExceeded,
} from "../src/api/strict-tool-limits.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";

afterEach(() => cleanupSessionResources());

test("fallback state expires by session, global cleanup, and oldest-insertion eviction", () => {
	markStrictToolLimitsExceeded(undefined);
	expect(hasExceededStrictToolLimits(undefined)).toBe(false);
	for (let index = 0; index < 10_000; index++) markStrictToolLimitsExceeded(String(index));
	markStrictToolLimitsExceeded("0");
	markStrictToolLimitsExceeded("newest");
	expect(hasExceededStrictToolLimits("0")).toBe(false);
	expect(hasExceededStrictToolLimits("1")).toBe(true);
	expect(hasExceededStrictToolLimits("newest")).toBe(true);
	cleanupSessionResources("1");
	expect(hasExceededStrictToolLimits("1")).toBe(false);
	expect(hasExceededStrictToolLimits("newest")).toBe(true);
	cleanupSessionResources();
	expect(hasExceededStrictToolLimits("newest")).toBe(false);
});

test("only recognizes provider strict-schema capacity diagnostics", () => {
	for (const message of [
		"The compiled grammar is too large",
		"Too many strict tools (23)",
		"Schemas contains too many parameters with union types (18)",
	])
		expect(isStrictToolLimitErrorMessage(`request rejected: ${message}`)).toBe(true);
	for (const message of ["Rate limit reached", "Invalid tool input", "", "Too many strict tools"])
		expect(isStrictToolLimitErrorMessage(message)).toBe(false);
});
