import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}
interface RenderHost {
	requestRender(force?: boolean): void;
}
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Loader extends Text {
	readonly #host: RenderHost;
	readonly #spinnerColor: (text: string) => string;
	readonly #messageColor: (text: string) => string;
	#message: string;
	#frames = [...frames];
	#interval = 80;
	#frame = 0;
	#verbatim = false;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		ui: RenderHost,
		spinnerColorFn: (text: string) => string,
		messageColorFn: (text: string) => string,
		message = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.#host = ui;
		this.#spinnerColor = spinnerColorFn;
		this.#messageColor = messageColorFn;
		this.#message = message;
		this.setIndicator(indicator);
	}
	override render(width: number): string[] {
		return ["", ...super.render(width)];
	}
	#update(): void {
		const indicator = this.getRenderedIndicator();
		this.setText((indicator ? indicator + " " : "") + this.#messageColor(this.#message));
		this.#host.requestRender();
	}
	protected getRenderedIndicator(): string {
		const frame = this.#frames[this.#frame] ?? "";
		return this.#verbatim ? frame : this.#spinnerColor(frame);
	}
	start(): void {
		this.#update();
		this.stop();
		if (this.#frames.length > 1)
			this.#timer = setInterval(() => {
				this.#frame = (this.#frame + 1) % this.#frames.length;
				this.#update();
			}, this.#interval);
	}
	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}
	setMessage(message: string): void {
		this.#message = message;
		this.#update();
	}
	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.#verbatim = indicator !== undefined;
		this.#frames = [...(indicator?.frames ?? frames)];
		this.#interval = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : 80;
		this.#frame = 0;
		this.start();
	}
	override invalidate(): void {
		super.invalidate();
		this.#update();
	}
}
