import wasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
import type { ImageProcessor } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

export function createCloudflarePhotonImages(): ImageProcessor {
	return createPhotonImages(wasm);
}
