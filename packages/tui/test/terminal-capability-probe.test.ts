import { afterEach, expect, test, vi } from "vitest";
import {
	detectCapabilities,
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilityOverrides,
} from "../src/terminal-image.ts";

const probe = vi.hoisted(() => vi.fn(() => ""));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFileSync: probe,
}));
afterEach(() => {
	vi.unstubAllEnvs();
	setCapabilityOverrides({});
	resetCapabilitiesCache();
	probe.mockReset();
});

test.each([
	{ features: "RGB, hyperlinks ,clipboard", expected: true },
	{ features: "RGB,clipboard", expected: false },
])("tmux capability output $features controls hyperlink detection", ({ features, expected }) => {
	vi.stubEnv("TMUX", "managed-session");
	vi.stubEnv("AXI_HYPERLINKS", undefined);
	probe.mockReturnValue(features);
	expect(detectCapabilities().hyperlinks).toBe(expected);
	expect(probe).toHaveBeenCalledWith(
		"tmux",
		["display-message", "-p", "#{client_termfeatures}"],
		expect.objectContaining({ timeout: 250, encoding: "utf8" }),
	);
});

test("a failed tmux feature query falls back to disabled hyperlinks", () => {
	vi.stubEnv("TMUX", "managed-session");
	vi.stubEnv("AXI_HYPERLINKS", undefined);
	probe.mockImplementation(() => {
		throw new Error("tmux unavailable");
	});
	expect(detectCapabilities().hyperlinks).toBe(false);
});

test("explicit hyperlink overrides bypass the external tmux feature query", () => {
	vi.stubEnv("TMUX", "managed-session");
	vi.stubEnv("AXI_HYPERLINKS", undefined);
	for (const hyperlinks of [true, false]) {
		setCapabilityOverrides({ hyperlinks });
		expect(getCapabilities().hyperlinks).toBe(hyperlinks);
	}
	expect(probe).not.toHaveBeenCalled();
});
