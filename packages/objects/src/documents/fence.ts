export class SealToken {
	#sealed = false;
	get sealed(): boolean {
		return this.#sealed;
	}
	seal(): void {
		this.#sealed = true;
	}
}
