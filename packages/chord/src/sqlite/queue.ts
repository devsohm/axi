export class OperationQueue {
	#tail: Promise<void> = Promise.resolve();
	#waiting = 0;

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.#waiting !== 0) return this.#append(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	hold<T>(operation: () => Promise<T>): Promise<T> {
		return this.#append(operation);
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#waiting !== 0) return this.#append(operation);
		this.#waiting++;
		const barrier = Promise.withResolvers<void>();
		this.#tail = barrier.promise;
		let result: Promise<T>;
		try {
			result = operation();
		} catch (error) {
			result = Promise.reject(error);
		}
		return result.finally(() => {
			this.#waiting--;
			barrier.resolve();
		});
	}

	#append<T>(operation: () => T | Promise<T>): Promise<T> {
		this.#waiting++;
		const result = this.#tail.then(operation).finally(() => {
			this.#waiting--;
		});
		this.#tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}
