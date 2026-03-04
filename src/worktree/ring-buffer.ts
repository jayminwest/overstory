/**
 * Fixed-size circular buffer for capturing process output.
 *
 * Used by WindowsSessionManager to buffer stdout lines from agent processes,
 * providing equivalent functionality to `tmux capture-pane -S -N`.
 * The buffer stores the last N lines and overwrites oldest entries when full.
 */

/**
 * A fixed-size ring buffer of strings (output lines).
 *
 * Thread-safe for single-writer/single-reader patterns: one async reader
 * drains stdout into the buffer, one caller reads via getLines().
 */
export class RingBuffer {
	private readonly buffer: string[];
	private readonly capacity: number;
	private head = 0;
	private count = 0;

	/**
	 * @param capacity - Maximum number of lines to retain (default 1000)
	 */
	constructor(capacity = 1000) {
		this.capacity = capacity;
		this.buffer = new Array<string>(capacity);
	}

	/**
	 * Append a single line to the buffer.
	 * If the buffer is full, overwrites the oldest line.
	 */
	push(line: string): void {
		const index = (this.head + this.count) % this.capacity;
		this.buffer[index] = line;
		if (this.count < this.capacity) {
			this.count++;
		} else {
			// Buffer full — advance head to overwrite oldest
			this.head = (this.head + 1) % this.capacity;
		}
	}

	/**
	 * Return the last N lines (or all lines if fewer than N are stored).
	 *
	 * @param n - Number of recent lines to return (default: all stored lines)
	 * @returns Array of lines in chronological order (oldest first)
	 */
	getLines(n?: number): string[] {
		const count = n !== undefined ? Math.min(n, this.count) : this.count;
		if (count === 0) return [];

		const startOffset = this.count - count;
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const index = (this.head + startOffset + i) % this.capacity;
			const line = this.buffer[index];
			if (line !== undefined) {
				lines.push(line);
			}
		}
		return lines;
	}

	/** Number of lines currently stored. */
	get size(): number {
		return this.count;
	}

	/** Clear all stored lines. */
	clear(): void {
		this.head = 0;
		this.count = 0;
	}
}

/**
 * Start an async reader that drains a ReadableStream into a RingBuffer.
 *
 * Splits incoming data on newlines and pushes each complete line to the buffer.
 * Incomplete trailing data (no newline) is buffered until the next chunk.
 *
 * @param stream - The ReadableStream to drain (typically process stdout)
 * @param buffer - The RingBuffer to write lines into
 * @returns A promise that resolves when the stream ends
 */
export async function drainStreamIntoBuffer(
	stream: ReadableStream<Uint8Array>,
	buffer: RingBuffer,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let partial = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const text = partial + decoder.decode(value, { stream: true });
			const lines = text.split("\n");

			// Last element is either empty (text ended with \n) or a partial line
			partial = lines.pop() ?? "";

			for (const line of lines) {
				buffer.push(line);
			}
		}

		// Flush any remaining partial line
		if (partial.length > 0) {
			buffer.push(partial);
		}
	} finally {
		reader.releaseLock();
	}
}
