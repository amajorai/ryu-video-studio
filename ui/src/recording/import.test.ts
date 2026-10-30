import { describe, expect, test } from "bun:test";
import { importMediaRequestSchema } from "../../../shared/import-media.ts";
import type { Asset } from "../../../shared/project.ts";
import { createTestRuntime, testProject } from "../editor/test-runtime.ts";
import {
	addRecordingToTimeline,
	base64ByteLength,
	importRecording,
	MAX_INLINE_RECORDING_BYTES,
	parseMediaDataUrl,
	RECORDING_FOLDER,
	type RecordingImportBody,
	type RecordingImportDependencies,
	recordingExtension,
	recordingName,
	SIDECAR_MAX_REQUEST_BODY_BYTES,
} from "./import.ts";

const audioAsset = (name: string, duration = 2.5): Asset => ({
	createdAt: new Date(0).toISOString(),
	duration,
	folder: RECORDING_FOLDER,
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio",
	name,
	width: 0,
});

function fakeImport(asset: Asset = audioAsset("Voiceover")) {
	const bodies: RecordingImportBody[] = [];
	const uploads: File[] = [];
	const filed: { folder: string; id: string }[] = [];
	const dependencies: RecordingImportDependencies = {
		fileInFolder: (uploaded, folder) => {
			filed.push({ folder, id: uploaded.id });
			return Promise.resolve({ ...uploaded, folder });
		},
		importAsset: (body) => {
			bodies.push(body);
			return Promise.resolve({ ...asset, name: body.name });
		},
		upload: (file) => {
			uploads.push(file);
			return Promise.resolve({ ...asset, kind: "video", name: file.name });
		},
	};
	return { bodies, dependencies, filed, uploads };
}

describe("parseMediaDataUrl", () => {
	test("splits base64 data URLs, including ones with parameters", () => {
		expect(parseMediaDataUrl("data:audio/wav;base64,UklGRg==")).toEqual({
			base64: "UklGRg==",
			mimeType: "audio/wav",
		});
		expect(
			parseMediaDataUrl("data:audio/webm;codecs=opus;base64,AAAA")
		).toEqual({ base64: "AAAA", mimeType: "audio/webm" });
	});

	test("rejects non-base64, empty, and malformed payloads", () => {
		expect(parseMediaDataUrl("data:audio/wav,plain")).toBeNull();
		expect(parseMediaDataUrl("data:audio/wav;base64,")).toBeNull();
		expect(parseMediaDataUrl("data:audio/wav;base64,@@@")).toBeNull();
		expect(parseMediaDataUrl("https://example.com/a.wav")).toBeNull();
	});
});

describe("recording helpers", () => {
	test("base64ByteLength accounts for padding", () => {
		expect(base64ByteLength(btoa("a"))).toBe(1);
		expect(base64ByteLength(btoa("ab"))).toBe(2);
		expect(base64ByteLength(btoa("abc"))).toBe(3);
	});

	test("recordingExtension ignores codec parameters", () => {
		expect(recordingExtension("video/webm;codecs=vp9,opus")).toBe("webm");
		expect(recordingExtension("audio/wav")).toBe("wav");
		expect(recordingExtension("audio/x-unknown")).toBe("wav");
	});

	test("recordingName stamps the local date and time", () => {
		expect(recordingName("Voiceover", new Date(2026, 9, 14, 9, 5))).toBe(
			"Voiceover 2026-10-14 09.05"
		);
	});
});

describe("importRecording", () => {
	test("sends small takes inline to /assets/import in the Recordings folder", async () => {
		const { bodies, dependencies, uploads } = fakeImport();
		const asset = await importRecording(
			{ base64: btoa("RIFF"), mimeType: "audio/wav", name: "Take" },
			dependencies
		);
		expect(asset.name).toBe("Take");
		expect(uploads).toHaveLength(0);
		expect(bodies).toEqual([
			{
				folder: RECORDING_FOLDER,
				name: "Take",
				source: { bytes: btoa("RIFF"), mimeType: "audio/wav" },
			},
		]);
	});

	test("encodes a Blob inline and drops codec parameters from the MIME type", async () => {
		const { bodies, dependencies } = fakeImport();
		await importRecording(
			{
				blob: new Blob(["webm"], { type: "video/webm" }),
				mimeType: "video/webm;codecs=vp9,opus",
				name: "Screen",
			},
			dependencies
		);
		expect(bodies[0]?.source).toEqual({
			bytes: btoa("webm"),
			mimeType: "video/webm",
		});
	});

	test("uses chunked uploads above the inline limit and files them under Recordings", async () => {
		const { bodies, dependencies, filed, uploads } = fakeImport(
			audioAsset("Upload")
		);
		const blob = new Blob([new Uint8Array(MAX_INLINE_RECORDING_BYTES + 1)], {
			type: "video/webm",
		});
		const asset = await importRecording(
			{ blob, mimeType: "video/webm", name: "Long screen" },
			dependencies
		);
		expect(bodies).toHaveLength(0);
		expect(uploads[0]?.name).toBe("Long screen.webm");
		expect(uploads[0]?.size).toBe(MAX_INLINE_RECORDING_BYTES + 1);
		expect(asset.name).toBe("Long screen.webm");
		expect(filed).toEqual([{ folder: RECORDING_FOLDER, id: asset.id }]);
		expect(asset.folder).toBe(RECORDING_FOLDER);
	});

	test("keeps a chunked upload when filing it into the folder fails", async () => {
		const { dependencies } = fakeImport({
			...audioAsset("Upload"),
			folder: undefined,
		});
		const asset = await importRecording(
			{
				blob: new Blob([new Uint8Array(MAX_INLINE_RECORDING_BYTES + 1)]),
				mimeType: "video/webm",
				name: "Long screen",
			},
			{
				...dependencies,
				fileInFolder: () => Promise.reject(new Error("offline")),
			}
		);
		expect(asset.name).toBe("Long screen.webm");
	});

	test("sends a 60 s voiceover (about 1.9 MB of WAV) through chunked uploads", async () => {
		const { bodies, dependencies, uploads } = fakeImport();
		const wav = new Uint8Array(60 * 32_000 + 44);
		await importRecording(
			{
				base64: Buffer.from(wav).toString("base64"),
				mimeType: "audio/wav",
				name: "Voiceover",
			},
			dependencies
		);
		expect(bodies).toHaveLength(0);
		expect(uploads[0]?.size).toBe(wav.length);
	});

	test("refuses an empty take", async () => {
		const { dependencies } = fakeImport();
		await expect(
			importRecording(
				{ blob: new Blob([]), mimeType: "video/webm", name: "Empty" },
				dependencies
			)
		).rejects.toThrow("empty");
	});
});

describe("inline import limit", () => {
	test("matches the sidecar's request body cap", async () => {
		const server = await Bun.file(
			new URL("../../../sidecar/src/server.ts", import.meta.url)
		).text();
		const match = /maxRequestBodySize:\s*([\d\s*]+),/.exec(server);
		expect(match?.[1]).toBeDefined();
		const limit = (match?.[1] ?? "")
			.split("*")
			.map((part) => Number(part.trim()))
			.reduce((product, factor) => product * factor, 1);
		expect(limit).toBe(SIDECAR_MAX_REQUEST_BODY_BYTES);
	});

	test("the largest inline take fits the body cap and the import schema", async () => {
		const { bodies, dependencies } = fakeImport();
		await importRecording(
			{
				blob: new Blob([new Uint8Array(MAX_INLINE_RECORDING_BYTES)]),
				mimeType: "audio/wav",
				name: "N".repeat(200),
			},
			dependencies
		);
		const body = bodies[0];
		expect(body).toBeDefined();
		expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
			SIDECAR_MAX_REQUEST_BODY_BYTES
		);
		expect(importMediaRequestSchema.safeParse(body).success).toBe(true);
	});
});

describe("addRecordingToTimeline", () => {
	test("imports the take and places it at the given time", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const { dependencies } = fakeImport(audioAsset("Voice", 3));
		const placed = await addRecordingToTimeline(
			runtime,
			{ base64: btoa("RIFF"), mimeType: "audio/wav", name: "Voice" },
			4,
			dependencies
		);
		expect(placed.placementError).toBeUndefined();
		const clip = runtime.project?.segments.find(
			(segment) => segment.id === placed.segmentId
		);
		expect(clip).toMatchObject({ start: 4, track: 1 });
		expect(runtime.selectedId).toBe(placed.segmentId);
		expect(runtime.calls.some(([name]) => name === "setAssets")).toBe(true);
	});

	test("keeps the asset and reports why a full timeline could not take the clip", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const { dependencies } = fakeImport(audioAsset("Voice", 0));
		const before = runtime.project;
		const placed = await addRecordingToTimeline(
			runtime,
			{ base64: btoa("RIFF"), mimeType: "audio/wav", name: "Voice" },
			4,
			dependencies
		);
		expect(placed.segmentId).toBeNull();
		expect(placed.placementError).toContain("in the library under Recordings");
		expect(runtime.project).toBe(before);
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
	});
});
