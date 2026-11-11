import { afterEach, beforeEach, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
	load: Object.assign(vi.fn(), { resolve: vi.fn() }),
}));
vi.mock("node:module", async (original) => ({
	...(await original<typeof import("node:module")>()),
	createRequire: () => native.load,
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;

function machine(os: string, arch = "x64") {
	Object.defineProperty(process, "platform", { value: os, configurable: true });
	Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

beforeEach(() => {
	vi.resetModules();
	native.load.mockReset();
	native.load.resolve.mockReset().mockImplementation(() => {
		throw new Error("No installed package");
	});
});
afterEach(() => {
	Object.defineProperty(process, "platform", platform);
	Object.defineProperty(process, "arch", architecture);
	vi.unstubAllEnvs();
});

test("native lookup keeps installation, module and executable locations in order without duplicates", async () => {
	const { getNativeModuleCandidates } = await import("../src/native-module-path.ts");
	const resolve = vi.fn(() => "/workspace/tui/dist/index.js");
	expect(
		getNativeModuleCandidates("native/helper.node", {
			moduleUrl: "file:///workspace/tui/dist/native-module-path.js",
			execPath: "/runtime/axi",
			resolvePackage: resolve,
		}),
	).toEqual([
		"/workspace/tui/native/helper.node",
		"/workspace/tui/dist/native/helper.node",
		"/runtime/native/helper.node",
	]);
	expect(resolve).toHaveBeenCalledWith("@axi/tui");
});

test("standalone lookup survives a missing installed package", async () => {
	const { getNativeModuleCandidates } = await import("../src/native-module-path.ts");
	expect(
		getNativeModuleCandidates("native/helper.node", {
			moduleUrl: "file:///application/entry.js",
			execPath: "/runtime/axi",
		}),
	).toEqual(["/native/helper.node", "/application/native/helper.node", "/runtime/native/helper.node"]);
});

test.each(["darwin", "win32"])("%s accepts a valid helper after an unusable candidate and reuses it", async (os) => {
	machine(os, "arm64");
	const helper = { getText: async () => "clipboard", getImage: async () => null };
	native.load.mockReturnValueOnce({ getText: "invalid" }).mockReturnValue(helper);
	const { getNativePlatformHelper, getNativeClipboard } = await import("../src/native-platform.ts");
	expect(getNativePlatformHelper()).toBe(helper);
	expect(getNativeClipboard()).toBe(helper);
	expect(native.load).toHaveBeenCalledTimes(2);
	expect(native.load.mock.calls[0][0]).toContain(`${os}-arm64`);
});

test("unavailable native modules are cached without failing clipboard access", async () => {
	machine("darwin");
	native.load.mockImplementation(() => {
		throw new Error("Unsupported binary");
	});
	const { getNativeClipboard } = await import("../src/native-platform.ts");
	expect(getNativeClipboard()).toBeUndefined();
	const attempts = native.load.mock.calls.length;
	expect(attempts).toBeGreaterThan(0);
	expect(getNativeClipboard()).toBeUndefined();
	expect(native.load).toHaveBeenCalledTimes(attempts);
});

test("clipboard module discovery can start after a Linux display becomes available", async () => {
	machine("linux");
	vi.stubEnv("DISPLAY", "");
	const helper = { getText: async () => null, getImage: async () => null };
	native.load.mockReturnValue(helper);
	const { getNativeClipboard, getNativePlatformHelper } = await import("../src/native-platform.ts");
	expect(getNativeClipboard()).toBeUndefined();
	expect(getNativePlatformHelper()).toBeUndefined();
	expect(native.load).not.toHaveBeenCalled();
	vi.stubEnv("DISPLAY", ":71");
	expect(getNativeClipboard()).toBe(helper);
	expect(native.load.mock.calls[0][0]).toContain("linux-platform-x11.node");
	vi.stubEnv("DISPLAY", "");
	expect(getNativeClipboard()).toBeUndefined();
	vi.stubEnv("DISPLAY", ":72");
	expect(getNativeClipboard()).toBe(helper);
	expect(native.load).toHaveBeenCalledOnce();
});

test.each([
	["freebsd", "x64"],
	["darwin", "ia32"],
	["win32", "ppc64"],
])("%s on %s leaves unsupported native loading disabled", async (os, arch) => {
	machine(os, arch);
	const { getNativeClipboard } = await import("../src/native-platform.ts");
	expect(getNativeClipboard()).toBeUndefined();
	expect(native.load).not.toHaveBeenCalled();
});

test("modifier checks require an explicit true value and tolerate a failing native query", async () => {
	machine("darwin");
	const pressed = vi.fn();
	native.load.mockReturnValue({ getText() {}, getImage() {}, isModifierPressed: pressed });
	const { isNativeModifierPressed } = await import("../src/native-modifiers.ts");
	for (const result of [undefined, null, false, 1, "true", true]) {
		pressed.mockReturnValue(result);
		expect(isNativeModifierPressed("shift")).toBe(result === true);
	}
	pressed.mockImplementation(() => {
		throw new Error("Display disconnected");
	});
	expect(isNativeModifierPressed("control")).toBe(false);
	expect(pressed).toHaveBeenLastCalledWith("control");
});

test("a helper without modifier support leaves modifiers unpressed", async () => {
	machine("win32");
	native.load.mockReturnValue({ getText() {}, getImage() {} });
	const { isNativeModifierPressed } = await import("../src/native-modifiers.ts");
	expect(isNativeModifierPressed("option")).toBe(false);
});
