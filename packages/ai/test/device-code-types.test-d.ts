import type { AuthEvent } from "../src/auth/types.ts";
import type { OAuthDeviceCodeInfo } from "../src/compat/extension-oauth-types.ts";

const options = {
	userCode: "ABCD",
	verificationUri: "https://example.test/activate",
	openBrowserOnConfirm: false,
	copyCodeOnConfirm: false,
} satisfies OAuthDeviceCodeInfo;
const event = { type: "device_code", ...options } satisfies AuthEvent;
const browser: boolean = event.openBrowserOnConfirm;
const clipboard: boolean = event.copyCodeOnConfirm;
void browser;
void clipboard;
