export const RETRY_INITIAL_MS = 250,
	RETRY_MAX_MS = 5000,
	STABLE_MS = 10_000,
	CONNECT_TIMEOUT_MS = 20_000,
	STALE_MS = 25_000,
	WAKE_GRACE_MS = 1000;
export type ConnectionState = "connecting" | "connected" | "waiting";
export interface SocketEvents {
	opened(): void;
	received(): void;
}
export interface LoopLink {
	onClose(listener: () => void): void;
	close(): void;
}
export interface LoopEnvironment {
	now(): number;
	after(ms: number, callback: () => void): () => void;
	online(): boolean;
	onWake(listener: () => void): () => void;
}
export type LoopOptions = {
	readonly open: (events: SocketEvents) => LoopLink;
	readonly onState: (state: ConnectionState) => void;
	/** Checked alongside reconnects. One pending answer covers later closes; false ends the loop. */
	readonly canRetry: () => Promise<boolean>;
	readonly environment: LoopEnvironment;
};

export function keepConnected(options: LoopOptions): { stop(): void } {
	const clock = options.environment;
	type Socket = { link?: LoopLink; opened?: number; frame: number; timeout(): void };
	let current: Socket | undefined,
		retries = 0,
		stopped = false,
		asking = false;
	let wokenAt: number | undefined;
	let retry: (() => void) | undefined, stale: (() => void) | undefined;
	function connect(): void {
		retry = undefined;
		const socket: Socket = { frame: clock.now(), timeout() {} };
		current = socket;
		options.onState("connecting");
		socket.link = options.open({
			opened() {
				if (current === socket) {
					socket.opened = socket.frame = clock.now();
					socket.timeout();
					options.onState("connected");
				}
			},
			received() {
				socket.frame = clock.now();
			},
		});
		socket.timeout = clock.after(CONNECT_TIMEOUT_MS, () => {
			if (socket.opened === undefined) socket.link!.close();
		});
		socket.link.onClose(() => {
			if (current !== socket) return;
			current = undefined;
			socket.timeout();
			stale?.();
			stale = undefined;
			if (stopped) return;
			options.onState("waiting");
			const now = clock.now();
			if (socket.opened !== undefined && now - socket.opened >= STABLE_MS) retries = 0;
			const immediate = wokenAt !== undefined && now - wokenAt <= STALE_MS + WAKE_GRACE_MS;
			wokenAt = undefined;
			const backoff = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** retries++);
			retry = clock.after(immediate ? 0 : clock.online() ? backoff : RETRY_MAX_MS, connect);
			if (asking) return;
			asking = true;
			const decided = (again: boolean): void => {
				asking = false;
				if (!again) stop();
			};
			void options.canRetry().then(decided, () => decided(true));
		});
	}
	const removeWake = clock.onWake(() => {
		wokenAt = clock.now();
		if (retry) {
			retry();
			connect();
			return;
		}
		const socket = current;
		if (socket?.opened === undefined) return;
		stale?.();
		stale = clock.after(Math.max(WAKE_GRACE_MS, socket.frame + STALE_MS + 1 - clock.now()), () => {
			stale = undefined;
			if (current === socket && clock.now() - socket.frame > STALE_MS) socket.link!.close();
		});
	});
	function stop(): void {
		if (stopped) return;
		stopped = true;
		removeWake();
		retry?.();
		retry = undefined;
		const socket = current;
		socket?.link?.close();
		if (socket !== undefined) options.onState("waiting");
	}
	connect();
	return { stop };
}
