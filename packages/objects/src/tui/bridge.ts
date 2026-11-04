export type BridgeStart = {
	readonly base: string;
	readonly combined: string;
	readonly columns: number;
	readonly rows: number;
	readonly colors: "truecolor" | "256";
	readonly mode: "dark" | "light";
	readonly locales: readonly string[];
};
export type BridgeRequest =
	| { readonly kind: "fetch"; readonly path: string }
	| { readonly kind: "base" }
	| { readonly kind: "copy"; readonly text: string }
	| { readonly kind: "open"; readonly url: string }
	| { readonly kind: "attach"; readonly path: string };
export type SandboxMessage =
	| { readonly kind: "write"; readonly data: string }
	| { readonly kind: "socket_open"; readonly socket: number }
	| { readonly kind: "socket_send"; readonly socket: number; readonly bytes: Uint8Array }
	| { readonly kind: "socket_close"; readonly socket: number }
	| { readonly kind: "request"; readonly id: number; readonly request: BridgeRequest }
	| { readonly kind: "outdated" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "exit"; readonly code: number };
export type LauncherMessage =
	| { readonly kind: "input"; readonly data: string }
	| { readonly kind: "resize"; readonly columns: number; readonly rows: number }
	| { readonly kind: "socket_opened"; readonly socket: number }
	| { readonly kind: "socket_message"; readonly socket: number; readonly bytes: Uint8Array }
	| { readonly kind: "socket_closed"; readonly socket: number }
	| { readonly kind: "reply"; readonly id: number; readonly value: unknown }
	| { readonly kind: "attached"; readonly id: number; readonly name: string; readonly bytes: Uint8Array }
	| { readonly kind: "refused"; readonly id: number; readonly message: string };
export type Bridge = {
	readonly start: BridgeStart;
	send(message: SandboxMessage): void;
	onMessage(listener: (message: LauncherMessage) => void): void;
	evaluate(source: string, filename: string): void;
};
export const BRIDGE = "objectsBridge";
