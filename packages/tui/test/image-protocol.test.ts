import { afterEach, expect, test, vi } from "vitest";
import {
	calculateImageCellSize,
	cropKittyImageLine,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getImageDimensions,
	getKittyImageMetadata,
	getKittyImagePlacement,
	getKittyImagePlacementRows,
	getTerminalColorMode,
	imageFallback,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
} from "../src/terminal-image.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	setCapabilityOverrides({});
	resetCapabilitiesCache();
});

function terminalEnv(values: Record<string, string>) {
	for (const name of [
		"TERM",
		"TERM_PROGRAM",
		"COLORTERM",
		"TMUX",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		"WEZTERM_PANE",
		"WARP_SESSION_ID",
		"WARP_TERMINAL_SESSION_UUID",
		"ITERM_SESSION_ID",
		"WT_SESSION",
		"TERMINAL_EMULATOR",
		"AXI_IMAGE_PROTOCOL",
		"AXI_TRUE_COLOR",
		"AXI_HYPERLINKS",
	])
		vi.stubEnv(name, values[name]);
}

test("terminal capabilities honor terminal families, multiplexers and explicit overrides", () => {
	for (const [env, expected] of [
		[{ TERM_PROGRAM: "kitty" }, { images: "kitty", trueColor: true, hyperlinks: true }],
		[{ TERM_PROGRAM: "iterm.app" }, { images: "iterm2", trueColor: true, hyperlinks: true }],
		[{ TERM_PROGRAM: "vscode" }, { images: null, trueColor: true, hyperlinks: true }],
		[{ TERM_PROGRAM: "herdr" }, { images: "kitty", trueColor: false, hyperlinks: true }],
		[{ TERM_PROGRAM: "rex" }, { images: "kitty", trueColor: true, hyperlinks: true }],
		[
			{ TERM: "screen", TERM_PROGRAM: "kitty", COLORTERM: "truecolor" },
			{ images: null, trueColor: true, hyperlinks: false },
		],
		[
			{ TMUX: "yes", TERM_PROGRAM: "kitty" },
			{ images: null, trueColor: false, hyperlinks: true },
		],
		[
			{ TERM: "tmux", AXI_HYPERLINKS: "0" },
			{ images: null, trueColor: false, hyperlinks: false },
		],
		[
			{ TERM_PROGRAM: "kitty", AXI_IMAGE_PROTOCOL: "none", AXI_TRUE_COLOR: "0", AXI_HYPERLINKS: "0" },
			{ images: null, trueColor: false, hyperlinks: false },
		],
		[
			{ AXI_IMAGE_PROTOCOL: "iterm2", AXI_TRUE_COLOR: "1", AXI_HYPERLINKS: "1" },
			{ images: "iterm2", trueColor: true, hyperlinks: true },
		],
	] satisfies [Record<string, string>, ReturnType<typeof detectCapabilities>][]) {
		terminalEnv(env);
		expect(detectCapabilities(() => true)).toEqual(expected);
	}
	terminalEnv({ TERM: "dumb" });
	setCapabilityOverrides({ images: "kitty", trueColor: true });
	expect(getCapabilities()).toEqual({ images: "kitty", trueColor: true, hyperlinks: false });
	expect(getTerminalColorMode()).toBe("truecolor");
	setCapabilityOverrides({ images: null, trueColor: false });
	expect(getTerminalColorMode()).toBe("256color");
});

test("Kitty chunking can replace a transmission with a cropped placement without changing adjacent text", () => {
	const data = "A".repeat(8200);
	registerKittyImageMetadata({ imageId: 71001, columns: 10, rows: 4, widthPx: 100, heightPx: 80 });
	const encoded = encodeKitty(data, { imageId: 71001, columns: 10, rows: 4, moveCursor: false });
	expect(encoded).toBe(
		`\x1b_Ga=T,f=100,q=2,C=1,c=10,r=4,i=71001,m=1;${"A".repeat(4096)}\x1b\\\x1b_Gm=1;${"A".repeat(4096)}\x1b\\\x1b_Gm=0;AAAAAAAA\x1b\\`,
	);
	const placement = getKittyImagePlacement(`before${encoded}after`);
	expect(placement).toMatchObject({
		imageId: 71001,
		transmissionBytes: encoded.length,
		estimatedDecodedBytes: 32000,
		rows: 4,
		sequence: "\x1b_Ga=p,q=2,C=1,c=10,r=4,i=71001\x1b\\",
		replacementLine: "before\x1b_Ga=p,q=2,C=1,c=10,r=4,i=71001\x1b\\after",
	});
	expect(getKittyImageMetadata(encoded)).toEqual({ imageId: 71001, columns: 10, rows: 4, widthPx: 100, heightPx: 80 });
	expect(getKittyImagePlacementRows("\x1b_Ga=p,i=71001;\x1b\\")).toBe(4);
	expect(cropKittyImageLine("\x1b_Ga=p,i=71001;\x1b\\", 1, 2)).toBe("\x1b_Ga=p,i=71001,y=20,h=40,r=2;\x1b\\");
	expect(cropKittyImageLine(encoded, 0, 4)).toBe(encoded);
	expect(cropKittyImageLine(encoded, 4, 1)).toBe(encoded);
	expect(getKittyImagePlacement(encoded.slice(0, -2))).toBeUndefined();
	expect(getKittyImagePlacement("\x1b_Gi=71001,m=1;AA\x1b\\broken")).toBeUndefined();
	expect(getKittyImagePlacement("\x1b_Gi=71001,m=1;AA\x1b\\\x1b_Gbroken")).toBeUndefined();
	expect(getKittyImagePlacement("plain")).toBeUndefined();
});

test("retransmission updates image generation and bounded metadata evicts the oldest image", () => {
	registerKittyImageMetadata({ imageId: 72000, columns: 2, rows: 2, widthPx: 20, heightPx: 40 });
	const first = getKittyImagePlacement(encodeKitty("AQ==", { imageId: 72000 }));
	registerKittyImageMetadata({ imageId: 72000, columns: 3, rows: 3, widthPx: 30, heightPx: 60 });
	const second = getKittyImagePlacement(encodeKitty("Ag==", { imageId: 72000 }));
	expect(second?.estimatedDecodedBytes).toBe(7200);
	expect(second?.transmissionGeneration).toBe((first?.transmissionGeneration ?? 0) + 1);
	for (let i = 0; i < 1001; i++)
		registerKittyImageMetadata({ imageId: 73000 + i, columns: 1, rows: 1, widthPx: 1, heightPx: 1 });
	expect(getKittyImageMetadata(encodeKitty("AQ==", { imageId: 72000 }))).toBeUndefined();
	expect(getKittyImageMetadata(encodeKitty("AQ==", { imageId: 74000 }))).toEqual({
		imageId: 74000,
		columns: 1,
		rows: 1,
		widthPx: 1,
		heightPx: 1,
	});
});

test("image sizing respects both bounds and iTerm encoding preserves binary length and names", () => {
	expect(calculateImageCellSize({ widthPx: 100, heightPx: 200 }, 10, 3, { widthPx: 10, heightPx: 20 })).toEqual({
		columns: 3,
		rows: 3,
	});
	expect(calculateImageCellSize({ widthPx: 100, heightPx: 100 }, 4, undefined, { widthPx: 10, heightPx: 20 })).toEqual({
		columns: 4,
		rows: 2,
	});
	expect(
		encodeITerm2("AQID", { width: 4, height: "auto", name: "x.png", preserveAspectRatio: false, inline: false }),
	).toBe("\x1b]1337;File=inline=0;size=3;width=4;height=auto;name=eC5wbmc=;preserveAspectRatio=0:AQID\x07");
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	expect(imageFallback("image/png", { widthPx: 2, heightPx: 3 }, "relative.png")).toBe(
		"[Image: relative.png [image/png] 2x3]",
	);
	setCapabilities({ images: null, trueColor: false, hyperlinks: true });
	expect(imageFallback("image/png", undefined, "/a b.png")).toBe(
		"[Image: \x1b]8;;file:///a%20b.png\x1b\\/a b.png\x1b]8;;\x1b\\ [image/png]]",
	);
});

test("image dimensions decode each WebP layout and reject unsupported or truncated headers", () => {
	for (const kind of ["VP8 ", "VP8L", "VP8X"]) {
		const bytes = Buffer.alloc(30);
		bytes.write("RIFF", 0);
		bytes.write("WEBP", 8);
		bytes.write(kind, 12);
		if (kind === "VP8 ") {
			bytes.writeUInt16LE(300, 26);
			bytes.writeUInt16LE(200, 28);
		} else if (kind === "VP8L") bytes.writeUInt32LE(299 | (199 << 14), 21);
		else {
			bytes.writeUIntLE(299, 24, 3);
			bytes.writeUIntLE(199, 27, 3);
		}
		expect(getImageDimensions(bytes.toString("base64"), "image/webp")).toEqual({ widthPx: 300, heightPx: 200 });
	}
	const jpeg = Buffer.alloc(15);
	jpeg[0] = 255;
	jpeg[1] = 216;
	jpeg[2] = 255;
	jpeg[3] = 192;
	jpeg.writeUInt16BE(40, 7);
	jpeg.writeUInt16BE(60, 9);
	expect(getImageDimensions(jpeg.toString("base64"), "image/jpeg")).toEqual({ widthPx: 60, heightPx: 40 });
	for (const mime of ["image/png", "image/gif", "image/jpeg", "image/webp", "image/bmp"])
		expect(getImageDimensions("AQ==", mime)).toBeNull();
	const invalid = Buffer.alloc(30);
	invalid.write("RIFF");
	invalid.write("WEBP", 8);
	invalid.write("XXXX", 12);
	expect(getImageDimensions(invalid.toString("base64"), "image/webp")).toBeNull();
});

test("PNG dimensions require literal signature bytes rather than their seven-bit ASCII aliases", () => {
	const bytes = Buffer.alloc(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47]);
	bytes.writeUInt32BE(30, 16);
	bytes.writeUInt32BE(20, 20);
	expect(getImageDimensions(bytes.toString("base64"), "image/png")).toEqual({ widthPx: 30, heightPx: 20 });
	for (const index of [1, 2, 3]) {
		const corrupted = Buffer.from(bytes);
		corrupted[index] |= 0x80;
		expect(getImageDimensions(corrupted.toString("base64"), "image/png")).toBeNull();
	}
});

test("image metadata lookup returns only placement dimensions and identity", () => {
	const registration = { imageId: 75001, columns: 3, rows: 2, widthPx: 30, heightPx: 40, privateLabel: "source" };
	registerKittyImageMetadata(registration);
	expect(getKittyImageMetadata(encodeKitty("AQ==", { imageId: 75001 }))).toEqual({
		imageId: 75001,
		columns: 3,
		rows: 2,
		widthPx: 30,
		heightPx: 40,
	});
});
