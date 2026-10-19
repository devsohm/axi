const pending: (() => void)[] = [];
let depth = 0;
let delivering = false;

function flush(): void {
	if (depth || delivering) return;
	delivering = true;
	try {
		for (let task = pending.shift(); task !== undefined; task = pending.shift()) task();
	} finally {
		delivering = false;
	}
}

export function enqueue(task: () => void): void {
	pending.push(task);
	flush();
}

export function holdPublications<T>(fn: () => T): T {
	depth++;
	try {
		return fn();
	} finally {
		depth--;
		flush();
	}
}
