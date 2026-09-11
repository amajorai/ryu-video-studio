import { describe, expect, test } from "bun:test";
import {
	resultForOpenverseAudio,
	resultForOpenverseImage,
	resultForUnsplashImage,
	selectArchiveVideoFile,
	selectNasaVideoFile,
	selectPexelsVideoFile,
	selectPixabayVideoFile,
	selectWikimediaVideoInfo,
	trustedCoverrVideoUrl,
	trustedPexelsVideoUrl,
	trustedPixabayVideoUrl,
	trustedUnsplashImageUrl,
} from "./stock.ts";

describe("Openverse audio catalog", () => {
	test("retains license and creator metadata in a stock result", () => {
		const result = resultForOpenverseAudio({
			creator: "The.madpix.project",
			duration: 270_000,
			filetype: "mp3",
			foreign_landing_url: "https://www.jamendo.com/track/1214935",
			id: "8624ba61-57f1-4f98-8a85-ece206c319cf",
			license: "by-nc-sa",
			license_version: "3.0",
			provider: "jamendo",
			title: "Wish You Were Here",
			url: "https://mp3d.jamendo.com/download/track/1214935/mp32",
		});
		expect(result.provider).toBe("openverse.audio");
		expect(result.duration).toBe(270);
		expect(result.rights).toContain("by-nc-sa 3.0");
	});
});

describe("Openverse image catalog", () => {
	test("retains license, creator, and image format metadata", () => {
		const result = resultForOpenverseImage({
			creator: "Tim Sullivan",
			filesize: 120_000,
			filetype: "jpg",
			foreign_landing_url: "https://stocksnap.io/photo/XNVBVXO3B7",
			height: 640,
			id: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
			license: "cc0",
			license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
			license_version: "1.0",
			provider: "stocksnap",
			title: "Tree Bark Photo",
			url: "https://cdn.stocksnap.io/img-thumbs/960w/XNVBVXO3B7.jpg",
			width: 960,
		});
		expect(result.provider).toBe("openverse.image");
		expect(result.format).toBe("jpg");
		expect(result.rights).toContain("cc0 1.0");
	});

	test("rejects image results without a supported HTTPS media URL", () => {
		expect(() =>
			resultForOpenverseImage({
				id: "4bc43a04-ef46-4544-a0c1-63c63f56e276",
				title: "Unsafe",
				url: "http://127.0.0.1/private",
			})
		).toThrow("trusted image URL");
	});
});

describe("Coverr stock selection", () => {
	test("accepts only trusted signed MP4 hosts", () => {
		expect(
			trustedCoverrVideoUrl("https://storage.coverr.co/videos/demo?token=test")
		).not.toBeNull();
		expect(trustedCoverrVideoUrl("https://example.com/video.mp4")).toBeNull();
	});
});

describe("Unsplash image catalog", () => {
	test("retains attribution and the Unsplash license", () => {
		const result = resultForUnsplashImage({
			alt_description: "A mountain lake",
			height: 1200,
			id: "abc_123",
			links: { html: "https://unsplash.com/photos/abc_123" },
			urls: {
				regular: "https://images.unsplash.com/photo-123?auto=format",
				small: "https://images.unsplash.com/photo-123?w=400",
			},
			user: { name: "Ada Photographer" },
			width: 1800,
		});
		expect(result.provider).toBe("unsplash.image");
		expect(result.attribution).toContain("Ada Photographer");
		expect(result.rights).toContain("Unsplash License");
	});

	test("accepts only HTTPS images.unsplash.com media", () => {
		expect(
			trustedUnsplashImageUrl("https://images.unsplash.com/photo-123")
		).not.toBeNull();
		expect(trustedUnsplashImageUrl("https://example.com/photo.jpg")).toBeNull();
		expect(
			trustedUnsplashImageUrl("http://images.unsplash.com/photo-123")
		).toBeNull();
	});
});

describe("Archive.org stock selection", () => {
	test("prefers a bounded MP4 over a larger alternate container", () => {
		const selected = selectArchiveVideoFile([
			{
				format: "QuickTime",
				name: "master.mov",
				size: "600000000",
			},
			{
				format: "h.264",
				length: "12",
				name: "preview.mp4",
				size: "12000000",
			},
		]);

		expect(selected?.name).toBe("preview.mp4");
	});

	test("rejects unsupported and oversized files", () => {
		const selected = selectArchiveVideoFile([
			{ format: "JPEG", name: "cover.jpg", size: "1000" },
			{ format: "h.264", name: "huge.mp4", size: "900000000" },
		]);

		expect(selected).toBeNull();
	});
});

describe("Wikimedia Commons stock selection", () => {
	test("keeps a bounded video and rejects an oversized source", () => {
		const selected = selectWikimediaVideoInfo({
			title: "File:Big Buck Bunny 4K.webm",
			imageinfo: [
				{
					mediatype: "VIDEO",
					size: 900_000_000,
					url: "https://upload.wikimedia.org/large.webm",
				},
			],
		});
		expect(selected).toBeNull();

		const bounded = selectWikimediaVideoInfo({
			title: "File:Big Buck Bunny extract.webm",
			imageinfo: [
				{
					mediatype: "VIDEO",
					size: 12_000_000,
					url: "https://upload.wikimedia.org/bounded.webm",
				},
			],
		});
		expect(bounded?.url).toContain("bounded.webm");
	});
});

describe("NASA Images and Video stock selection", () => {
	test("prefers a bounded small MP4 from the trusted NASA asset host", () => {
		const selected = selectNasaVideoFile([
			"https://images-assets.nasa.gov/video/demo/demo~orig.mp4",
			"https://images-assets.nasa.gov/video/demo/demo~small.mp4",
			"https://example.com/demo~small.mp4",
			"https://images-assets.nasa.gov/video/demo/demo.srt",
		]);
		expect(selected).not.toBeNull();
		expect(selected).toContain("~small.mp4");
	});

	test("rejects untrusted and unsupported NASA asset entries", () => {
		expect(
			selectNasaVideoFile([
				"https://images-assets.nasa.gov/video/demo/demo.json",
				"https://example.com/video/demo.mp4",
			])
		).toBeNull();
	});
});

describe("Pexels stock selection", () => {
	test("prefers a trusted high-resolution MP4 over HLS", () => {
		const selected = selectPexelsVideoFile([
			{
				file_type: "video/mp4",
				height: 720,
				link: "https://player.vimeo.com/external/123.hd.mp4",
				quality: "hd",
				width: 1280,
			},
			{
				file_type: "video/mp4",
				height: 1080,
				link: "https://videos.pexels.com/video-files/123.mp4",
				quality: "hd",
				width: 1920,
			},
			{
				file_type: "video/mp4",
				link: "https://player.vimeo.com/external/123.m3u8",
				quality: "hls",
			},
		]);
		expect(selected?.link).toContain("videos.pexels.com");
	});

	test("rejects untrusted download hosts and non-HTTPS URLs", () => {
		expect(
			selectPexelsVideoFile([
				{ file_type: "video/mp4", link: "https://example.com/video.mp4" },
				{ file_type: "video/mp4", link: "http://videos.pexels.com/video.mp4" },
			])
		).toBeNull();
		expect(
			trustedPexelsVideoUrl("https://vod-progressive.akamaized.net/video.mp4")
		).not.toBeNull();
		expect(trustedPexelsVideoUrl("https://example.com/video.mp4")).toBeNull();
	});
});

describe("Pixabay stock selection", () => {
	test("prefers the highest-resolution bounded MP4 rendition", () => {
		const selected = selectPixabayVideoFile({
			large: {
				height: 2160,
				size: 700 * 1024 * 1024,
				url: "https://cdn.pixabay.com/video/large.mp4",
				width: 3840,
			},
			medium: {
				height: 1080,
				size: 80 * 1024 * 1024,
				url: "https://cdn.pixabay.com/video/medium.mp4",
				width: 1920,
			},
			tiny: {
				url: "https://cdn.pixabay.com/video/tiny.mp4",
			},
		});
		expect(selected?.url).toContain("medium.mp4");
	});

	test("rejects untrusted hosts and non-MP4 files", () => {
		expect(
			selectPixabayVideoFile({
				bad: { url: "https://example.com/video.mp4" },
				stream: { url: "https://cdn.pixabay.com/video/live.m3u8" },
			})
		).toBeNull();
		expect(
			trustedPixabayVideoUrl("https://cdn.pixabay.com/video/sample.mp4")
		).not.toBeNull();
		expect(trustedPixabayVideoUrl("https://example.com/video.mp4")).toBeNull();
	});
});
