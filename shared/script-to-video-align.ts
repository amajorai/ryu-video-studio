/**
 * Script to video caption alignment: map transcribed or estimated word
 * timings onto the script's narration text.
 */

/** A timed word, in seconds from the start of its narration clip. */
export interface NarrationWord {
	end: number;
	start: number;
	text: string;
}

const normalizeToken = (token: string) =>
	token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const tokensOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** Character edit distance between two short tokens. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			current[j] = Math.min(
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/**
 * Whether a transcribed word is the same script word, allowing ASR spelling
 * slips: at most a third of the longer token's characters differ.
 */
export function similarTokens(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const longest = Math.max(a.length, b.length);
	return longest >= 3 && editDistance(a, b) * 3 <= longest;
}

/**
 * Pair script tokens with transcribed words in order (a longest common
 * subsequence over similar tokens). Returns, per script token, the index of
 * the measured word it takes timing from; unrelated words never pair, so
 * a script word the transcript lacks is spread instead of mistimed.
 */
function alignTokens(
	script: readonly string[],
	measured: readonly string[]
): (number | undefined)[] {
	const rows = script.length + 1;
	const cols = measured.length + 1;
	const score = new Uint32Array(rows * cols);
	const same = (i: number, j: number) =>
		similarTokens(script[i - 1] ?? "", measured[j - 1] ?? "");
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			score[i * cols + j] = same(i, j)
				? (score[(i - 1) * cols + j - 1] ?? 0) + 1
				: Math.max(
						score[(i - 1) * cols + j] ?? 0,
						score[i * cols + j - 1] ?? 0
					);
		}
	}
	const pairs: (number | undefined)[] = new Array(script.length);
	let i = script.length;
	let j = measured.length;
	while (i > 0 && j > 0) {
		if (
			same(i, j) &&
			score[i * cols + j] === (score[(i - 1) * cols + j - 1] ?? 0) + 1
		) {
			pairs[i - 1] = j - 1;
			i -= 1;
			j -= 1;
		} else if (
			(score[(i - 1) * cols + j] ?? 0) >= (score[i * cols + j - 1] ?? 0)
		) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return pairs;
}

/** Spread `tokens` over `[start, end]` in proportion to their length. */
export function spread(
	tokens: readonly string[],
	start: number,
	end: number
): NarrationWord[] {
	const weights = tokens.map((token) => token.length + 1);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let cursor = start;
	return tokens.map((text, index) => {
		const from = cursor;
		cursor =
			index === tokens.length - 1
				? end
				: cursor + ((end - start) * (weights[index] ?? 0)) / total;
		return { end: cursor, start: from, text };
	});
}

/**
 * Make word times strictly increasing inside `[0, duration]`, each word at
 * least `minimum` long (captions require `end > start`).
 */
function normalizeWordTimes(
	words: NarrationWord[],
	duration: number
): NarrationWord[] {
	if (!words.length) {
		return words;
	}
	const minimum = Math.min(0.02, duration / (words.length * 2));
	const result = words.map((word) => ({
		...word,
		end: Math.min(duration, Math.max(0, word.end)),
		start: Math.min(duration, Math.max(0, word.start)),
	}));
	let floor = 0;
	for (const word of result) {
		word.start = Math.max(word.start, floor);
		word.end = Math.max(word.end, word.start + minimum);
		floor = word.end;
	}
	let ceiling = duration;
	for (let index = result.length - 1; index >= 0; index -= 1) {
		const word = result[index];
		if (!word) {
			continue;
		}
		word.end = Math.min(word.end, ceiling);
		word.start = Math.min(word.start, word.end - minimum);
		ceiling = word.start;
	}
	return result;
}

/**
 * Time every token of the scene's narration `text` against `measured` words
 * from transcribing its audio. Matched tokens take the measured timing (the
 * script's spelling is kept); unmatched runs are spread between their timed
 * neighbours. With nothing measured the whole clip is spread by length.
 */
export function alignNarrationWords(
	text: string,
	measured: readonly NarrationWord[],
	duration: number
): NarrationWord[] {
	const tokens = tokensOf(text);
	if (!tokens.length || duration <= 0) {
		return [];
	}
	const usable = measured
		.filter(
			(word) =>
				Number.isFinite(word.start) &&
				Number.isFinite(word.end) &&
				word.end > word.start &&
				word.start < duration &&
				normalizeToken(word.text)
		)
		.sort((a, b) => a.start - b.start);
	if (!usable.length) {
		return normalizeWordTimes(spread(tokens, 0, duration), duration);
	}
	const pairs = alignTokens(
		tokens.map(normalizeToken),
		usable.map((word) => normalizeToken(word.text))
	);
	const words: (NarrationWord | undefined)[] = tokens.map((token, index) => {
		const match = pairs[index];
		const source = match === undefined ? undefined : usable[match];
		return source
			? {
					end: Math.min(duration, source.end),
					start: source.start,
					text: token,
				}
			: undefined;
	});
	let index = 0;
	while (index < tokens.length) {
		if (words[index]) {
			index += 1;
			continue;
		}
		let stop = index;
		while (stop < tokens.length && !words[stop]) {
			stop += 1;
		}
		const from = words[index - 1]?.end ?? 0;
		const to = words[stop]?.start ?? duration;
		const filled = spread(tokens.slice(index, stop), from, Math.max(from, to));
		for (const [offset, word] of filled.entries()) {
			words[index + offset] = word;
		}
		index = stop;
	}
	return normalizeWordTimes(
		words.filter((word): word is NarrationWord => word !== undefined),
		duration
	);
}
