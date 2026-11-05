/** One reservation covers a complete operation, including its nested processes. */
const MAX_ACTIVE_OPERATIONS = 2;
let activeOperations = 0;
export class MediaBusyError extends Error {
	constructor() {
		super(
			"Two media operations are already running. Wait or cancel an operation before trying again."
		);
	}
}
export class MediaOperation {
	readonly signal: AbortSignal;
	private readonly deadline: number;
	private readonly timer: ReturnType<typeof setTimeout>;
	private released = false;
	private constructor(timeoutMs: number, signal?: AbortSignal) {
		this.deadline = Date.now() + timeoutMs;
		const deadline = new AbortController();
		this.timer = setTimeout(() => deadline.abort(), timeoutMs);
		this.signal = signal
			? AbortSignal.any([signal, deadline.signal])
			: deadline.signal;
	}
	static acquire(timeoutMs: number, signal?: AbortSignal): MediaOperation {
		signal?.throwIfAborted();
		if (activeOperations >= MAX_ACTIVE_OPERATIONS) {
			throw new MediaBusyError();
		}
		const operation = new MediaOperation(timeoutMs, signal);
		activeOperations++;
		return operation;
	}
	remainingMs(): number {
		this.check();
		return Math.max(1, this.deadline - Date.now());
	}
	check(): void {
		if (Date.now() >= this.deadline) {
			throw new Error("The complete media operation exceeded its time limit.");
		}
		if (this.signal.aborted) {
			throw new Error("Media operation canceled.");
		}
	}
	release(): void {
		if (!this.released) {
			this.released = true;
			clearTimeout(this.timer);
			activeOperations--;
		}
	}
}
export function acquireMediaOperation(
	timeoutMs: number,
	signal?: AbortSignal
): MediaOperation {
	return MediaOperation.acquire(timeoutMs, signal);
}
export async function withMediaOperation<T>(
	timeoutMs: number,
	options: { signal?: AbortSignal; operation?: MediaOperation },
	work: (operation: MediaOperation) => Promise<T>
): Promise<T> {
	const operation =
		options.operation ?? acquireMediaOperation(timeoutMs, options.signal);
	try {
		operation.check();
		return await work(operation);
	} finally {
		if (!options.operation) {
			operation.release();
		}
	}
}
