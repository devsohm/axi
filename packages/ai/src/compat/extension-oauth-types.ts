export type { OAuthCredentials } from "../auth/types.ts";
export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}
export interface OAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	/** Offer to open the browser after confirmation; enabled by default. */
	openBrowserOnConfirm?: boolean;
	/** Offer to replace the clipboard with the code after confirmation; enabled by default. */
	copyCodeOnConfirm?: boolean;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}
export interface OAuthSelectOption {
	id: string;
	label: string;
}
export interface OAuthSelectPrompt {
	message: string;
	options: OAuthSelectOption[];
}
export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void;
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	signal?: AbortSignal;
}
