import { z } from "zod";
import {
	type Asset,
	type Project,
	projectDuration,
	segmentDuration,
} from "./project.ts";

export const interchangeFormatSchema = z.enum(["fcpxml", "xmeml"]);
export type InterchangeFormat = z.infer<typeof interchangeFormatSchema>;

const xml = (value: string | number | undefined): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const decimal = (value: number) => Number(value.toFixed(6)).toString();
const frameCount = (seconds: number, fps: number) =>
	Math.max(0, Math.round(seconds * fps));
const assetSource = (asset: Asset) =>
	`ryu://video-studio/assets/${encodeURIComponent(asset.id)}`;

function referencedAssets(project: Project, assets: readonly Asset[]): Asset[] {
	const available = new Map(assets.map((asset) => [asset.id, asset]));
	const seen = new Set<string>();
	const result: Asset[] = [];
	for (const segment of project.segments) {
		if (seen.has(segment.assetId)) {
			continue;
		}
		const asset = available.get(segment.assetId);
		if (asset) {
			seen.add(asset.id);
			result.push(asset);
		}
	}
	return result;
}

function xmemlText(project: Project, assets: readonly Asset[]): string {
	const duration = projectDuration(project);
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const tracks = [
		...new Set(project.segments.map((segment) => segment.track)),
	].sort((a, b) => a - b);
	const trackText = (kind: "audio" | "video") =>
		tracks
			.map((track) => {
				const segments = project.segments
					.filter((segment) => segment.track === track)
					.sort((a, b) => a.start - b.start);
				const clipItems = segments
					.filter((segment) => {
						const asset = assetById.get(segment.assetId);
						return kind === "audio"
							? asset?.kind === "audio"
							: asset?.kind !== "audio";
					})
					.map((segment) => {
						const asset = assetById.get(segment.assetId);
						if (!asset) {
							return "";
						}
						const start = frameCount(segment.start, project.fps);
						const clipDuration = frameCount(
							segmentDuration(segment),
							project.fps
						);
						const sourceIn = frameCount(segment.sourceIn, project.fps);
						const sourceOut = frameCount(segment.sourceOut, project.fps);
						return `
              <clipitem id="${xml(segment.id)}">
                <name>${xml(asset.name)}</name>
                <duration>${clipDuration}</duration>
                <start>${start}</start>
                <end>${start + clipDuration}</end>
                <in>${sourceIn}</in>
                <out>${sourceOut}</out>
                <rate><timebase>${project.fps}</timebase><ntsc>FALSE</ntsc></rate>
                <file id="file-${xml(asset.id)}">
                  <name>${xml(asset.name)}</name>
                  <pathurl>${xml(assetSource(asset))}</pathurl>
                </file>
              </clipitem>`;
					})
					.join("");
				return `
          <track id="${kind}-track-${track}">${clipItems}
          </track>`;
			})
			.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="${xml(project.id)}">
    <name>${xml(project.title)}</name>
    <duration>${frameCount(duration, project.fps)}</duration>
    <rate><timebase>${project.fps}</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>${trackText("video")}</video>
      <audio>${trackText("audio")}</audio>
    </media>
  </sequence>
</xmeml>
`;
}

function fcpxmlText(project: Project, assets: readonly Asset[]): string {
	const duration = projectDuration(project);
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const resources = assets
		.map(
			(asset, index) => `
      <asset id="asset-${index + 1}" name="${xml(asset.name)}" src="${xml(assetSource(asset))}" duration="${decimal(asset.duration)}s" />`
		)
		.join("");
	const resourceId = new Map(
		assets.map((asset, index) => [asset.id, `asset-${index + 1}`])
	);
	const clips = [...project.segments]
		.sort((a, b) => a.start - b.start || a.track - b.track)
		.map((segment) => {
			const asset = assetById.get(segment.assetId);
			const ref = resourceId.get(segment.assetId);
			if (!(asset && ref)) {
				return "";
			}
			const attributes = [
				`ref="${xml(ref)}"`,
				`name="${xml(asset.name)}"`,
				`offset="${decimal(segment.start)}s"`,
				`start="${decimal(segment.sourceIn)}s"`,
				`duration="${decimal(segmentDuration(segment))}s"`,
				...(segment.track === 0 ? [] : [`lane="${segment.track}"`]),
				...(asset.kind === "audio" ? [`audioRole="Dialogue"`] : []),
			];
			return `
        <asset-clip ${attributes.join(" ")} />`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="format-1" name="Ryu ${project.width}x${project.height}" frameDuration="1/${project.fps}s" width="${project.width}" height="${project.height}" />${resources}
  </resources>
  <library>
    <event name="${xml(project.title)}">
      <project name="${xml(project.title)}">
        <sequence format="format-1" duration="${decimal(duration)}s" tcStart="0s" tcFormat="NDF">
          <spine>${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** Serialize the saved timeline for import into Final Cut/Resolve or Premiere. */
export function interchangeText(
	project: Project,
	assets: readonly Asset[],
	format: InterchangeFormat
): string {
	const referenced = referencedAssets(project, assets);
	return format === "fcpxml"
		? fcpxmlText(project, referenced)
		: xmemlText(project, referenced);
}

export function interchangeFilename(
	project: Pick<Project, "title">,
	format: InterchangeFormat
): string {
	const safeTitle = project.title
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${safeTitle || "video-studio-project"}.${format === "fcpxml" ? "fcpxml" : "xml"}`;
}
