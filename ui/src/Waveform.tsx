import { useEffect, useState } from "react";
import type { AudioPlayback } from "../../shared/audio.ts";
import { waveformPoints } from "../../shared/waveform.ts";
import { decodePreviewAudio } from "./audio-preview.ts";
import { mediaDataUrlBlob, request } from "./bridge.ts";

interface Entry {
	promise: Promise<AudioBuffer>;
	token: symbol;
	users: number;
}
const cache = new Map<string, Entry>();
let decoding: Promise<unknown> = Promise.resolve();
function acquire(assetId: string, start: number, playback: AudioPlayback) {
	const key = `${assetId}:${start}:${playback.sourceOut}:${playback.speed}:${playback.offset}`;
	let entry = cache.get(key);
	if (entry) {
		entry.users++;
	} else {
		const token = Symbol(key);
		const promise = decoding.then(async () => {
			if (cache.get(key)?.token !== token) {
				throw new Error("Preview window no longer needed");
			}
			const window = await request<{ dataUrl: string }>(
				`/assets/${assetId}/audio-window`,
				"POST",
				{ start, playback }
			);
			const bytes = await mediaDataUrlBlob(window.dataUrl).arrayBuffer();
			return await decodePreviewAudio(bytes);
		});
		entry = { token, users: 1, promise };
		cache.set(key, entry);
		decoding = promise.catch(() => undefined);
	}
	const current = entry;
	return {
		promise: entry.promise,
		release() {
			current.users--;
			if (current.users === 0 && cache.get(key) === current) {
				cache.delete(key);
			}
		},
	};
}
export function Waveform({
	assetId,
	sourceIn,
	sourceOut,
	speed,
	time,
	fps,
	color,
	height,
}: {
	assetId: string;
	sourceIn: number;
	sourceOut: number;
	speed: number;
	time: number;
	fps: number;
	color: string;
	height: number;
}) {
	const [decoded, setDecoded] = useState<{
		key: string;
		buffer: AudioBuffer;
	} | null>(null);
	const [error, setError] = useState(false);
	const frameTime = Math.max(0, Math.floor(time * fps + 1e-7) / fps);
	const start = Math.floor(frameTime / 20) * 20;
	const key = `${assetId}:${sourceIn}:${sourceOut}:${speed}:${start}`;
	const buffer = decoded?.key === key ? decoded.buffer : null;
	useEffect(() => {
		let mounted = true;
		setDecoded(null);
		setError(false);
		const handle = acquire(assetId, sourceIn, {
			sourceOut,
			speed,
			offset: start,
		});
		void handle.promise
			.then((value) => {
				if (mounted) {
					setDecoded({ key, buffer: value });
				}
			})
			.catch(() => {
				if (mounted) {
					setError(true);
				}
			});
		return () => {
			mounted = false;
			handle.release();
		};
	}, [assetId, start, sourceIn, sourceOut, speed, key]);
	if (error) {
		return (
			<span className="studio-waveform-message">
				Waveform preview unavailable
			</span>
		);
	}
	if (!buffer) {
		return <span className="studio-waveform-message">Preparing waveform…</span>;
	}
	const samples = waveformPoints(
		Array.from({ length: buffer.numberOfChannels }, (_, index) =>
			buffer.getChannelData(index)
		),
		buffer.sampleRate,
		frameTime - start,
		fps
	);
	const points = samples
		.map(
			(value, index) =>
				`${(index / (samples.length - 1)) * 1000},${500 - value * 500 * height}`
		)
		.join(" ");
	return (
		<svg
			aria-label="Source audio waveform"
			className="studio-waveform"
			preserveAspectRatio="none"
			role="img"
			viewBox="0 0 1000 1000"
		>
			<title>Source audio waveform</title>
			<polyline
				fill="none"
				points={points}
				stroke={color}
				strokeWidth="2"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
