/** Samples a source PCM window; it never substitutes decorative/random audio data. */
export function waveformPoints(
	channels: Float32Array[],
	sampleRate: number,
	time: number,
	fps: number,
	points = 512
): number[] {
	if (
		!channels.length ||
		sampleRate <= 0 ||
		fps <= 0 ||
		!Number.isFinite(time)
	) {
		return [];
	}
	const start = Math.max(0, Math.floor(time * sampleRate));
	const span = sampleRate / fps;
	return Array.from({ length: points }, (_, index) => {
		const sample = start + Math.floor((index / Math.max(1, points - 1)) * span);
		let value = 0;
		for (const channel of channels) {
			value += channel[sample] ?? 0;
		}
		return Math.max(-1, Math.min(1, value / channels.length));
	});
}
