import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppField,
	RyuAppMain,
	RyuAppSection,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import {
	useCallback,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import {
	manageClipLinks,
	overlappingLinkCandidate,
} from "../../shared/clip-links.ts";
import { insertClips as insertClipsAt } from "../../shared/insert.ts";
import {
	applyLayout as applyLayoutPreset,
	type Layout,
} from "../../shared/layouts.ts";
import {
	applySceneDraft,
	sceneDraftRequest,
} from "../../shared/production-prompts.ts";
import type { ProductionReadiness } from "../../shared/production-readiness.ts";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Keyframe,
	newSegment,
	type Project,
	parseSubtitles,
	projectDuration,
	projectSchema,
	rippleDeleteRange,
	type SceneReviewStatus,
	type Segment,
	sceneReviewStatusSchema,
	segmentDuration,
	splitSegment,
	subtitleText,
	trackSettingFor,
	trimSegment,
	updateTrackSetting,
	withActiveCaptions,
} from "../../shared/project.ts";
import type { RenderReview } from "../../shared/render-review.ts";
import {
	styleProfileConfig,
	styleProfileOptions,
} from "../../shared/styles.ts";
import { reorderTracks, trackOrderFor } from "../../shared/track-edits.ts";
import {
	captionsForSource,
	highlightedCaptionsForSource,
} from "../../shared/transcript.ts";
import { AssetOrganization } from "./AssetOrganization.tsx";
import { AssetPreview } from "./AssetPreview.tsx";
import { AvatarPanel } from "./AvatarPanel.tsx";
import { resumePreviewAudio } from "./audio-preview.ts";
import {
	download,
	loadLibrary,
	mediaBlob,
	request,
	uploadMedia,
} from "./bridge.ts";
import { ColorScopes } from "./ColorScopes.tsx";
import { CreditsPanel } from "./CreditsPanel.tsx";
import { DecisionLogPanel } from "./DecisionLogPanel.tsx";
import { DubCaptions } from "./DubCaptions.tsx";
import { GenerationPanel } from "./GenerationPanel.tsx";
import { GraphicsPanel } from "./GraphicsPanel.tsx";
import { LayoutPanel } from "./LayoutPanel.tsx";
import { MeshPanel } from "./MeshPanel.tsx";
import { MulticamPanel } from "./MulticamPanel.tsx";
import { NumberField } from "./NumberField.tsx";
import { Preview } from "./Preview.tsx";
import { ProductionActivityPanel } from "./ProductionActivityPanel.tsx";
import { ProductionBudgetPanel } from "./ProductionBudgetPanel.tsx";
import { ProductionPreflightPanel } from "./ProductionPreflightPanel.tsx";
import { ProductionStagesPanel } from "./ProductionStagesPanel.tsx";
import { PreviewSources } from "./preview-sources.ts";
import { RecipePanel } from "./RecipePanel.tsx";
import { ReferencePanel } from "./ReferencePanel.tsx";
import { ResearchSourcesPanel } from "./ResearchSourcesPanel.tsx";
import { SceneContactSheet } from "./SceneContactSheet.tsx";
import { SceneMedia } from "./SceneMedia.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { SequencePanel } from "./SequencePanel.tsx";
import { SoundtrackPanel } from "./SoundtrackPanel.tsx";
import { SourceAnalysis } from "./SourceAnalysis.tsx";
import { StagePanel } from "./StagePanel.tsx";
import { StockPanel } from "./StockPanel.tsx";
import { SyncPanel } from "./SyncPanel.tsx";
import { TimelineClip } from "./TimelineClip.tsx";
import { TitlesPanel } from "./TitlesPanel.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { TranslateCaptions } from "./TranslateCaptions.tsx";

interface Job {
	codec?: Project["exportCodec"];
	error?: string;
	id: string;
	progress: number;
	projectId: string;
	review?: RenderReview;
	revision: number;
	status: string;
}
const clock = (value: number) =>
	`${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
const exportFormat = (codec: Job["codec"]) =>
	codec === "prores"
		? { extension: "mov", label: "MOV", mime: "video/quicktime" }
		: { extension: "mp4", label: "MP4", mime: "video/mp4" };
const message = (error: unknown) =>
	error instanceof Error ? error.message : "The operation failed.";
const defaultMarkerColor = "#f59e0b";
const sceneReviewStatus = (
	scene: Project["scenes"][number]
): SceneReviewStatus =>
	scene.approved
		? "approved"
		: scene.reviewStatus === "changes-requested"
			? "changes-requested"
			: "in-review";
const sceneReviewLabel = (status: SceneReviewStatus) =>
	status === "changes-requested"
		? "Changes requested"
		: status === "approved"
			? "Approved"
			: "In review";
const rulerMarkerLabel = (label: string) =>
	label.startsWith("Peak ")
		? `P${label.slice("Peak ".length)}`
		: label.startsWith("Beat ")
			? `B${label.slice("Beat ".length)}`
			: label;

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProject] = useState<Project | null>(null);
	const latestProject = useRef<Project | null>(null);
	useEffect(() => {
		latestProject.current = project;
	}, [project]);
	const [assets, setAssets] = useState<Asset[]>([]);
	const [sources, setSources] = useState<Record<string, string>>({});
	const [previewSources] = useState(
		() =>
			new PreviewSources((asset, signal) =>
				mediaBlob(
					`/assets/${asset.id}/data`,
					asset.kind === "audio"
						? "audio/mpeg"
						: asset.kind === "image"
							? "image/png"
							: "video/mp4",
					signal
				)
			)
	);
	const [status, setStatus] = useState("Connecting to Video Studio…");
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [drafting, setDrafting] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	useEffect(() => {
		if (!selected) {
			if (selectedIds.length) {
				setSelectedIds([]);
			}
			return;
		}
		if (!selectedIds.includes(selected)) {
			setSelectedIds([selected]);
		}
	}, [selected, selectedIds]);
	const [time, setTimeState] = useState(0);
	const playbackPosition = useRef(0);
	const playbackOrigin = useRef({ time: 0, at: 0 });
	const setTime = useCallback((value: number) => {
		playbackPosition.current = value;
		playbackOrigin.current = { time: value, at: performance.now() };
		setTimeState(value);
	}, []);
	const [playing, setPlaying] = useState(false);
	const [playbackDirection, setPlaybackDirection] = useState<1 | -1>(1);
	const [panel, setPanel] = useState("media");
	const [history, setHistory] = useState<Project[]>([]);
	const [future, setFuture] = useState<Project[]>([]);
	const [jobs, setJobs] = useState<Job[]>([]);
	const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
	const renderStates = useRef<Record<string, string>>({});
	const renderRevision = useRef(0);
	const [zoom, setZoom] = useState(70);
	const [query, setQuery] = useState("");
	const [importUrl, setImportUrl] = useState("");
	const [markerLabel, setMarkerLabel] = useState("");
	const [markerColor, setMarkerColor] = useState(defaultMarkerColor);
	const [mediaFolder, setMediaFolder] = useState("");
	const [rangeStart, setRangeStart] = useState(0);
	const [rangeEnd, setRangeEnd] = useState(1);
	const [animationProperty, setAnimationProperty] =
		useState<Keyframe["property"]>("scale");
	const picker = useRef<HTMLInputElement>(null);
	const captionPicker = useRef<HTMLInputElement>(null);
	const packagePicker = useRef<HTMLInputElement>(null);
	const selectedSegment = project?.segments.find((s) => s.id === selected);
	const linkCandidate =
		project && selectedSegment
			? overlappingLinkCandidate(project, assets, selectedSegment.id)
			: undefined;
	const selectedTrackLocked = Boolean(
		project &&
			selectedSegment &&
			trackSettingFor(project, selectedSegment.track).locked
	);
	const selectedIsAudio =
		assets.find((asset) => asset.id === selectedSegment?.assetId)?.kind ===
		"audio";
	const visualControls =
		!selectedIsAudio || selectedSegment?.visualization === "waveform";
	const animationMode = visualControls ? animationProperty : "volume";
	const duration = project ? projectDuration(project) : 0;
	const editingCaptions = project ? activeCaptions(project) : [];
	const mediaFolders = [
		...new Set(assets.flatMap((asset) => (asset.folder ? [asset.folder] : []))),
	].sort();

	const act = useCallback(async (operation: () => Promise<void>) => {
		setBusy(true);
		try {
			await operation();
		} catch (error) {
			setStatus(message(error));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		let mounted = true;
		void loadLibrary()
			.then((library) => {
				if (!mounted) {
					return;
				}
				setProjects(library.projects);
				setAssets(library.assets);
				setProject(library.projects[0] ?? null);
				setReady(true);
				setStatus("Project library connected.");
			})
			.catch((error) => {
				if (mounted) {
					setStatus(message(error));
				}
			});
		return () => {
			mounted = false;
			previewSources.dispose();
		};
	}, [previewSources]);
	useEffect(() => {
		if (!ready) {
			return;
		}
		let mounted = true;
		let pending = false;
		const poll = () => {
			if (!mounted || pending || !isViewVisible()) {
				return;
			}
			pending = true;
			const revision = renderRevision.current;
			void request<{ jobs: Job[] }>("/renders")
				.then((result) => {
					if (!mounted || revision !== renderRevision.current) {
						return;
					}
					setJobs(result.jobs);
					const nextStates: Record<string, string> = {};
					for (const job of result.jobs) {
						const previous = renderStates.current[job.id];
						if (
							previous &&
							["pending", "running"].includes(previous) &&
							["completed", "failed", "canceled"].includes(job.status)
						) {
							setStatus(
								job.status === "completed"
									? "Export completed. Your video is ready to download."
									: (job.error ?? `Export ${job.status}.`)
							);
						}
						nextStates[job.id] = job.status;
					}
					renderStates.current = nextStates;
				})
				.catch((error) => {
					if (mounted && revision === renderRevision.current) {
						setStatus(message(error));
					}
				})
				.finally(() => {
					pending = false;
				});
		};
		const unsubscribe = subscribeViewVisibility(poll);
		poll();
		const timer = setInterval(poll, 1500);
		return () => {
			mounted = false;
			unsubscribe();
			clearInterval(timer);
		};
	}, [ready]);
	useEffect(() => {
		if (!(ready && project) || panel !== "storyboard") {
			return;
		}
		let mounted = true;
		void request<ProductionReadiness>(`/projects/${project.id}/readiness`)
			.then((value) => {
				if (mounted) {
					setReadiness(value);
				}
			})
			.catch((error) => {
				if (mounted) {
					setStatus(message(error));
				}
			});
		return () => {
			mounted = false;
		};
	}, [panel, project?.id, project?.revision, ready]);
	useEffect(() => {
		if (!playing) {
			return;
		}
		playbackOrigin.current = {
			time: playbackPosition.current,
			at: performance.now(),
		};
		let frame = 0;
		const tick = (now: number) => {
			const next = Math.max(
				0,
				Math.min(
					duration,
					playbackOrigin.current.time +
						(playbackDirection * (now - playbackOrigin.current.at)) / 1000
				)
			);
			playbackPosition.current = next;
			setTimeState(next);
			if (
				(playbackDirection > 0 && next >= duration) ||
				(playbackDirection < 0 && next <= 0)
			) {
				setPlaying(false);
				return;
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing, duration, playbackDirection]);

	useEffect(() => {
		const ids = new Set(
			project?.segments.map((segment) => segment.assetId) ?? []
		);
		return previewSources.sync(
			assets.filter((asset) => ids.has(asset.id)),
			setSources,
			(error) => setStatus(message(error))
		);
	}, [
		project?.id,
		project?.segments.map((s) => s.assetId).join(","),
		assets,
		previewSources,
	]);

	const draftScenes = async () => {
		if (!project || drafting) {
			return;
		}
		setDrafting(true);
		setStatus("Drafting scenes with Ryu. You can continue editing.");
		try {
			const complete = window.ryu?.model?.complete;
			if (!complete) {
				throw new Error("Ryu's model service is unavailable.");
			}
			const result = await complete(sceneDraftRequest(project.brief));
			const current = latestProject.current;
			if (!current) {
				throw new Error("The project was closed during drafting.");
			}
			const next = applySceneDraft(
				current,
				{ id: project.id, brief: project.brief },
				JSON.parse(result)
			);
			setHistory((history) => [...history.slice(-99), current]);
			setFuture([]);
			setProject(next);
			setDirty(true);
			setStatus("Draft scenes added for review. No media has been generated.");
		} catch (error) {
			setStatus(message(error));
		} finally {
			setDrafting(false);
		}
	};

	const edit = (next: Project) => {
		if (!project) {
			return;
		}
		setHistory((current) => [...current.slice(-99), project]);
		setFuture([]);
		setProject(next);
		setDirty(true);
	};
	const editCaptions = (captions: Caption[]) => {
		if (project) {
			edit(withActiveCaptions(project, captions));
		}
	};
	const changeSegment = (patch: Partial<Segment>) => {
		if (
			project &&
			selected &&
			!selectedTrackLocked &&
			(patch.track === undefined ||
				!trackSettingFor(project, patch.track).locked)
		) {
			edit({
				...project,
				segments: project.segments.map((s) =>
					s.id === selected ? { ...s, ...patch } : s
				),
			});
		} else if (selectedTrackLocked) {
			setStatus("Unlock this track before editing its clips.");
		} else if (project && patch.track !== undefined) {
			setStatus("Unlock the destination track before moving a clip there.");
		}
	};
	const setTrackSetting = (
		track: number,
		patch: Parameters<typeof updateTrackSetting>[2]
	) => {
		if (!project) {
			return;
		}
		edit(updateTrackSetting(project, track, patch));
	};
	const renameTrack = (track: number, value: string) => {
		const setting = project ? trackSettingFor(project, track) : undefined;
		if (!setting) {
			return;
		}
		const name = value.trim() || `Track ${track + 1}`;
		if (name !== setting.name) {
			setTrackSetting(track, { name });
		}
	};
	const moveTrack = (track: number, direction: -1 | 1) => {
		if (!project) {
			return;
		}
		const order = trackOrderFor(project);
		const index = order.indexOf(track);
		const destination = index + direction;
		if (index < 0 || destination < 0 || destination >= order.length) {
			return;
		}
		const currentTrack = order[index];
		const destinationTrack = order[destination];
		if (currentTrack === undefined || destinationTrack === undefined) {
			return;
		}
		order[index] = destinationTrack;
		order[destination] = currentTrack;
		edit(reorderTracks(project, order));
	};
	const arrangeLayout = (layout: Layout, segmentIds: string[]) => {
		if (!project) {
			return;
		}
		try {
			const next = applyLayoutPreset(project, segmentIds, layout);
			edit(next);
			const first = next.segments.find(
				(segment) => segment.id === segmentIds[0]
			);
			if (first) {
				setSelected(first.id);
				setTime(first.start);
			}
			setStatus(`${layout} layout applied to ${segmentIds.length} clips.`);
		} catch (error) {
			setStatus(message(error));
		}
	};
	const editedScene = (
		id: string,
		patch: Partial<Project["scenes"][number]>
	) => {
		if (!project) {
			return;
		}
		edit({
			...project,
			scenes: project.scenes.map((scene) =>
				scene.id === id ? { ...scene, ...patch } : scene
			),
		});
	};
	const addMarker = () => {
		if (!project) {
			return;
		}
		const markerTime = Number(Math.max(0, Math.min(duration, time)).toFixed(3));
		if (project.markers.some((marker) => marker.time === markerTime)) {
			setStatus("Move the playhead before adding another marker at this time.");
			return;
		}
		const label = markerLabel.trim() || `Marker ${project.markers.length + 1}`;
		edit({
			...project,
			markers: [
				...project.markers,
				{
					color: markerColor,
					id: crypto.randomUUID(),
					label,
					time: markerTime,
				},
			].sort((a, b) => a.time - b.time),
		});
		setMarkerLabel("");
		setStatus(`Marker added at ${clock(markerTime)}.`);
	};
	const addAnalysisMarkers = (
		times: readonly number[],
		prefix: string,
		color: string,
		description: string,
		assetName: string
	) => {
		if (!project) {
			return;
		}
		const existing = new Set(project.markers.map((marker) => marker.time));
		let sequence = project.markers.length + 1;
		const available = Math.max(0, 500 - project.markers.length);
		if (available === 0) {
			setStatus("This project already has the 500-marker limit.");
			return;
		}
		const next = times.flatMap((time) => {
			const markerTime = Number(
				Math.max(0, Math.min(duration, time)).toFixed(3)
			);
			if (existing.has(markerTime)) {
				return [];
			}
			existing.add(markerTime);
			return [
				{
					color,
					id: crypto.randomUUID(),
					label: `${prefix} ${sequence++}`,
					time: markerTime,
				},
			];
		});
		if (!next.length) {
			setStatus(`These ${description}s are already marked.`);
			return;
		}
		const added = next.slice(0, available);
		edit({
			...project,
			markers: [...project.markers, ...added].sort((a, b) => a.time - b.time),
		});
		setStatus(
			`Added ${added.length} ${description}${added.length === 1 ? "" : "s"} from ${assetName}.`
		);
	};
	const addLoudnessMarkers = (times: readonly number[], assetName: string) =>
		addAnalysisMarkers(times, "Peak", "#38bdf8", "loudness marker", assetName);
	const addBeatMarkers = (times: readonly number[], assetName: string) =>
		addAnalysisMarkers(
			times,
			"Beat",
			"#f97316",
			"estimated beat marker",
			assetName
		);
	const deleteRange = () => {
		if (!project) {
			return;
		}
		try {
			const deleted = rangeEnd - rangeStart;
			const next = rippleDeleteRange(project, assets, rangeStart, rangeEnd);
			const nextDuration = projectDuration(next);
			edit(next);
			if (
				selected &&
				!next.segments.some((segment) => segment.id === selected)
			) {
				setSelected(null);
			}
			setTime(Math.min(time, nextDuration));
			const nextRangeStart = Math.min(rangeStart, nextDuration);
			setRangeStart(nextRangeStart);
			setRangeEnd(Math.min(nextDuration, nextRangeStart + 1));
			setStatus(`Ripple-deleted ${clock(deleted)} from the timeline.`);
		} catch (error) {
			setStatus(message(error));
		}
	};
	const removeDetectedSilence = (
		assetId: string,
		assetName: string,
		sourceRanges: readonly [number, number][]
	) => {
		if (!project) {
			return;
		}
		const timelineRanges = project.segments
			.filter((segment) => segment.assetId === assetId)
			.flatMap((segment) =>
				sourceRanges.flatMap(([sourceStart, sourceEnd]) => {
					const start = Math.max(sourceStart, segment.sourceIn);
					const end = Math.min(sourceEnd, segment.sourceOut);
					return end - start >= 0.04
						? [
								[
									segment.start + (start - segment.sourceIn) / segment.speed,
									segment.start + (end - segment.sourceIn) / segment.speed,
								] as [number, number],
							]
						: [];
				})
			)
			.sort((a, b) => a[0] - b[0]);
		const merged: [number, number][] = [];
		for (const range of timelineRanges) {
			const previous = merged.at(-1);
			if (previous && range[0] <= previous[1]) {
				previous[1] = Math.max(previous[1], range[1]);
			} else {
				merged.push([...range]);
			}
		}
		if (!merged.length) {
			setStatus(`Add ${assetName} to the timeline before removing silence.`);
			return;
		}
		let next = project;
		let removed = 0;
		try {
			for (const [start, end] of [...merged].reverse()) {
				next = rippleDeleteRange(next, assets, start, end);
				removed += end - start;
			}
		} catch (error) {
			setStatus(message(error));
			return;
		}
		edit(next);
		if (selected && !next.segments.some((segment) => segment.id === selected)) {
			setSelected(null);
		}
		setTime(Math.min(time, projectDuration(next)));
		setStatus(
			`Removed ${clock(removed)} of detected silence from ${assetName}.`
		);
	};
	const markRangeStart = () => {
		const next = Math.min(duration, Math.max(0, time));
		setRangeStart(next);
		if (rangeEnd <= next + 0.04) {
			setRangeEnd(Math.min(duration, next + 1));
		}
		setStatus(`Range start set to ${clock(next)}.`);
	};
	const markRangeEnd = () => {
		const next = Math.min(duration, Math.max(0, time));
		if (next <= rangeStart + 0.04) {
			setStatus(
				"Move the playhead after the range start before marking its end."
			);
			return;
		}
		setRangeEnd(next);
		setStatus(`Range end set to ${clock(next)}.`);
	};
	const removeMarker = (id: string) => {
		if (!project) {
			return;
		}
		edit({
			...project,
			markers: project.markers.filter((marker) => marker.id !== id),
		});
	};
	const navigateMarker = (direction: -1 | 1) => {
		if (!project?.markers.length) {
			setStatus("Add a timeline marker before navigating markers.");
			return;
		}
		const ordered = [...project.markers].sort((a, b) => a.time - b.time);
		const target =
			direction < 0
				? ([...ordered]
						.reverse()
						.find((marker) => marker.time < time - 0.001) ?? ordered.at(-1))
				: (ordered.find((marker) => marker.time > time + 0.001) ?? ordered[0]);
		if (target) {
			setPlaying(false);
			setTime(target.time);
			setStatus(`Marker ${target.label} · ${clock(target.time)}.`);
		}
	};
	const save = async () => {
		if (!project) {
			throw new Error("Create a project first.");
		}
		const saved = projectSchema.parse(
			await request(`/projects/${project.id}`, "PUT", project)
		);
		setProject(saved);
		setProjects((current) => [
			saved,
			...current.filter((p) => p.id !== saved.id),
		]);
		setDirty(false);
		setStatus("Project saved.");
		return saved;
	};
	const importPackage = async (file: File) => {
		const bundle = JSON.parse(await file.text()) as unknown;
		const imported = await request<Project>(
			"/projects/package",
			"POST",
			bundle
		);
		setProjects((current) => [
			imported,
			...current.filter((item) => item.id !== imported.id),
		]);
		setProject(imported);
		setHistory([]);
		setFuture([]);
		setSelected(null);
		setDirty(false);
		setStatus("Production package imported as a new project.");
	};
	const downloadInterchange = (format: "fcpxml" | "xmeml") =>
		act(async () => {
			const saved = dirty ? await save() : project;
			if (!saved) {
				return;
			}
			const result = await request<{
				filename: string;
				format: string;
				text: string;
			}>(`/projects/${saved.id}/interchange?format=${format}`);
			download(
				new Blob([result.text], { type: "application/xml" }),
				result.filename
			);
			setStatus(
				format === "fcpxml"
					? "FCPXML timeline downloaded for Final Cut or Resolve."
					: "Premiere XMEML timeline downloaded."
			);
		});
	const addAsset = (asset: Asset) => {
		if (!project) {
			setStatus("Create a project before adding media to the timeline.");
			return;
		}
		const segment = newSegment(asset, duration, asset.kind === "audio" ? 1 : 0);
		edit({ ...project, segments: [...project.segments, segment] });
		setSelected(segment.id);
		setTime(segment.start);
	};
	const undo = () => {
		const previous = history.at(-1);
		if (!(previous && project)) {
			return;
		}
		setFuture((current) => [project, ...current]);
		setHistory(history.slice(0, -1));
		setProject({ ...previous, revision: project.revision });
		setDirty(true);
	};
	const redo = () => {
		const next = future[0];
		if (!(next && project)) {
			return;
		}
		setHistory((current) => [...current, project]);
		setFuture(future.slice(1));
		setProject({ ...next, revision: project.revision });
		setDirty(true);
	};
	const split = () => {
		if (!(project && selectedSegment) || selectedTrackLocked) {
			if (selectedTrackLocked) {
				setStatus("Unlock this track before splitting its clips.");
			}
			return;
		}
		try {
			const parts = splitSegment(selectedSegment, time);
			edit({
				...project,
				segments: project.segments.flatMap((s) =>
					s.id === selected ? parts : [s]
				),
			});
		} catch (error) {
			setStatus(message(error));
		}
	};
	const duplicateSelected = () => {
		if (!(project && selectedSegment) || selectedTrackLocked) {
			if (selectedTrackLocked) {
				setStatus("Unlock this track before duplicating its clips.");
			}
			return;
		}
		const copy = {
			...selectedSegment,
			id: crypto.randomUUID(),
			start: Math.min(
				7200 - segmentDuration(selectedSegment),
				selectedSegment.start + segmentDuration(selectedSegment)
			),
		};
		edit({ ...project, segments: [...project.segments, copy] });
		setSelected(copy.id);
		setTime(copy.start);
	};
	const nudgeSelected = (direction: -1 | 1) => {
		if (!(project && selectedSegment) || selectedTrackLocked) {
			if (selectedTrackLocked) {
				setStatus("Unlock this track before moving its clips.");
			}
			return;
		}
		const start = Math.max(
			0,
			Math.min(
				7200 - segmentDuration(selectedSegment),
				selectedSegment.start + direction / project.fps
			)
		);
		edit({
			...project,
			segments: project.segments.map((segment) =>
				segment.id === selectedSegment.id ? { ...segment, start } : segment
			),
		});
		setTime(start);
	};
	const trimSelectedToPlayhead = (edge: "start" | "end") => {
		if (!(project && selectedSegment) || selectedTrackLocked) {
			if (selectedTrackLocked) {
				setStatus("Unlock this track before trimming its clips.");
			}
			return;
		}
		const asset = assets.find(
			(candidate) => candidate.id === selectedSegment.assetId
		);
		if (!asset) {
			return;
		}
		const currentEdge =
			edge === "start"
				? selectedSegment.start
				: selectedSegment.start + segmentDuration(selectedSegment);
		const delta = time - currentEdge;
		try {
			const trimmed = trimSegment(selectedSegment, asset.duration, edge, delta);
			edit({
				...project,
				segments: project.segments.map((segment) =>
					segment.id === selectedSegment.id ? trimmed : segment
				),
			});
			setTime(
				edge === "start"
					? trimmed.start
					: trimmed.start + segmentDuration(trimmed)
			);
			setStatus(
				`Trimmed ${edge === "start" ? "start" : "end"} to ${clock(time)}.`
			);
		} catch (error) {
			setStatus(message(error));
		}
	};
	const insertSelectedAtPlayhead = () => {
		if (!(project && selectedSegment) || selectedTrackLocked) {
			if (selectedTrackLocked) {
				setStatus("Unlock this track before inserting a clip.");
			}
			return;
		}
		const asset = assets.find(
			(candidate) => candidate.id === selectedSegment.assetId
		);
		if (!asset || trackSettingFor(project, selectedSegment.track).locked) {
			setStatus("Unlock this track before inserting a clip.");
			return;
		}
		try {
			const at = Math.max(0, Math.min(duration, time));
			const next = insertClipsAt(project, assets, at, selectedSegment.track, [
				{
					assetId: asset.id,
					sourceIn: selectedSegment.sourceIn,
					sourceOut: selectedSegment.sourceOut,
					speed: selectedSegment.speed,
					volume: selectedSegment.volume,
				},
			]);
			edit(next);
			setTime(at);
			setStatus(
				`Inserted ${asset.name} at ${clock(at)} and rippled later layers.`
			);
		} catch (error) {
			setStatus(message(error));
		}
	};
	const syncProject = (input: {
		offsetSeconds?: number;
		mode: "auto" | "manual" | "timecode";
		referenceClipId: string;
		targetClipIds: string[];
	}) =>
		act(async () => {
			if (!project) {
				return;
			}
			const previous = project;
			const saved = dirty ? await save() : project;
			if (!saved) {
				return;
			}
			const result = await request<{
				matches: Array<{
					alignmentOffsetSeconds: number;
					confidence: number;
					method: string;
					offsetSeconds: number;
				}>;
				project: Project;
				shiftedFrames: number;
			}>(`/projects/${saved.id}/sync`, "POST", {
				...input,
				revision: saved.revision,
			});
			setHistory((current) => [...current.slice(-99), previous]);
			setFuture([]);
			setProject(result.project);
			setProjects((current) => [
				result.project,
				...current.filter((item) => item.id !== result.project.id),
			]);
			setDirty(false);
			setSelected(input.referenceClipId);
			const reference = result.project.segments.find(
				(segment) => segment.id === input.referenceClipId
			);
			if (reference) {
				setTime(reference.start);
			}
			const confidence = result.matches
				.map((match) => `${Math.round(match.confidence * 100)}%`)
				.join(", ");
			setStatus(
				`${input.mode === "manual" ? "Shifted" : "Aligned"} ${result.matches.length} clip${result.matches.length === 1 ? "" : "s"}${confidence ? ` · confidence ${confidence}` : ""}.`
			);
		});
	const manageMulticam = (body: Record<string, unknown>, statusText: string) =>
		act(async () => {
			if (!project) {
				return;
			}
			const previous = project;
			const saved = dirty ? await save() : project;
			if (!saved) {
				return;
			}
			const result = await request<{
				group?: Project["multicamGroups"][number];
				project: Project;
			}>(`/projects/${saved.id}/multicam`, "POST", {
				...body,
				revision: saved.revision,
			});
			setHistory((current) => [...current.slice(-99), previous]);
			setFuture([]);
			setProject(result.project);
			setProjects((current) => [
				result.project,
				...current.filter((item) => item.id !== result.project.id),
			]);
			setDirty(false);
			setSelected(null);
			if (result.group) {
				setTime(result.group.start);
			}
			setStatus(statusText);
		});
	const create = () =>
		act(async () => {
			if (dirty) {
				await save();
			}
			const next = projectSchema.parse(
				await request("/projects", "POST", {
					title: `Untitled film ${projects.length + 1}`,
				})
			);
			setProjects([next, ...projects]);
			setProject(next);
			setSelected(null);
			setHistory([]);
			setFuture([]);
			setTime(0);
			setRangeStart(0);
			setRangeEnd(1);
			setStatus("Project created. Import footage, audio, or images.");
		});
	const duplicate = () =>
		act(async () => {
			if (!project) {
				return;
			}
			const saved = dirty ? await save() : project;
			const next = projectSchema.parse(
				await request(`/projects/${saved.id}/duplicate`, "POST", {
					title: `${saved.title} copy`,
				})
			);
			setProjects((current) => [next, ...current]);
			setProject(next);
			setSelected(null);
			setHistory([]);
			setFuture([]);
			setTime(0);
			setRangeStart(0);
			setRangeEnd(1);
			setStatus(
				"Project duplicated. This alternate cut has its own revision history."
			);
		});
	const importFiles = (files: FileList | null) =>
		act(async () => {
			if (!files) {
				return;
			}
			for (const file of Array.from(files)) {
				const asset = await uploadMedia(file, (progress) =>
					setStatus(`Importing ${file.name} · ${Math.round(progress * 100)}%`)
				);
				setAssets((current) => [asset, ...current]);
			}
			setStatus("Media imported. Add it to the timeline from the library.");
		});
	const importRemoteMedia = () =>
		act(async () => {
			const url = importUrl.trim();
			if (!url) {
				throw new Error("Enter an HTTPS media URL first.");
			}
			const parsed = new URL(url);
			const filename = parsed.pathname.split("/").filter(Boolean).at(-1);
			const asset = await request<Asset>("/assets/import", "POST", {
				name: filename || undefined,
				source: { url },
			});
			setAssets((current) => [asset, ...current]);
			setImportUrl("");
			setStatus(
				"Remote media imported. Add it to the timeline from the library."
			);
		});
	const exportVideo = () =>
		act(async () => {
			const saved = dirty ? await save() : project;
			if (!saved) {
				return;
			}
			const job = await request<Job>(`/projects/${saved.id}/render`, "POST");
			renderRevision.current += 1;
			renderStates.current[job.id] = job.status;
			setJobs((current) => [job, ...current]);
			setPanel("exports");
			setStatus("Rendering the saved timeline. You can continue editing.");
		});
	const captureFrame = () =>
		act(async () => {
			const saved = dirty ? await save() : project;
			if (!saved) {
				return;
			}
			const asset = await request<Asset>(
				`/projects/${saved.id}/capture-frame`,
				"POST",
				{
					name: `${saved.title} frame ${clock(time)}`,
					revision: saved.revision,
					time,
				}
			);
			setAssets((current) => [asset, ...current]);
			setPanel("media");
			setStatus(
				`Captured a PNG frame at ${clock(time)} and added it to the library.`
			);
		});
	const organizeAsset = (
		asset: Asset,
		patch: { folder?: string; name?: string },
		remove = false
	) =>
		act(async () => {
			let currentProjects = projects;
			if (remove && dirty) {
				const saved = await save();
				currentProjects = currentProjects.map((item) =>
					item.id === saved.id ? saved : item
				);
			}
			const result = await request<{
				asset: Asset;
				clipsRemoved: number;
				deleted: boolean;
				projects: Project[];
			}>(`/assets/${asset.id}/organize`, "POST", {
				...patch,
				delete: remove,
				...(remove
					? {
							projectRevisions: Object.fromEntries(
								currentProjects.map((item) => [item.id, item.revision])
							),
						}
					: {}),
			});
			if (!result.deleted) {
				setAssets((current) =>
					current.map((item) =>
						item.id === result.asset.id ? result.asset : item
					)
				);
				setStatus(`${result.asset.name} metadata saved.`);
				return;
			}
			setAssets((current) => current.filter((item) => item.id !== asset.id));
			if (asset.folder === mediaFolder) {
				setMediaFolder("");
			}
			previewSources.remove(asset.id);
			setSources(previewSources.snapshot());
			setProjects(result.projects);
			const current = result.projects.find((item) => item.id === project?.id);
			if (current) {
				setProject(current);
				if (
					selected &&
					!current.segments.some((segment) => segment.id === selected)
				) {
					setSelected(null);
				}
			} else {
				setProject(null);
				setSelected(null);
			}
			setStatus(
				`Deleted ${asset.name}; removed ${result.clipsRemoved} timeline clip${result.clipsRemoved === 1 ? "" : "s"}.`
			);
		});
	const upscaleAsset = (asset: Asset, factor: 2 | 4) =>
		act(async () => {
			const next = await request<Asset>(`/assets/${asset.id}/upscale`, "POST", {
				factor,
			});
			setAssets((current) => [next, ...current]);
			setStatus(`${next.name} added to the media library.`);
		});
	const createSequenceClip = (source: Project) =>
		act(async () => {
			if (!project) {
				return;
			}
			const saved = dirty ? await save() : project;
			const asset = await request<Asset>(
				`/projects/${saved.id}/sequence`,
				"POST",
				{
					name: `Sequence · ${source.title}`,
					revision: saved.revision,
					sourceProjectId: source.id,
				}
			);
			setAssets((current) => [asset, ...current]);
			setProject(saved);
			setStatus(`${asset.name} added to the media library.`);
		});
	const refreshSequence = (asset: Asset) =>
		act(async () => {
			const next = await request<Asset>(
				`/assets/${asset.id}/refresh-sequence`,
				"POST",
				{}
			);
			setAssets((current) =>
				current.map((item) => (item.id === next.id ? next : item))
			);
			setStatus(`${next.name} refreshed from its source timeline.`);
		});
	const deleteSelected = () => {
		if (!project) {
			return;
		}
		const ids = new Set(
			selectedIds.length ? selectedIds : selected ? [selected] : []
		);
		if (!ids.size) {
			return;
		}
		const locked = project.segments.some(
			(segment) =>
				ids.has(segment.id) && trackSettingFor(project, segment.track).locked
		);
		if (locked) {
			setStatus("Unlock every selected clip track before deleting.");
			return;
		}
		const linkedGroups = new Set(
			project.segments
				.filter((segment) => ids.has(segment.id) && segment.linkGroupId)
				.map((segment) => segment.linkGroupId)
		);
		edit({
			...project,
			segments: project.segments.filter(
				(segment) =>
					!(
						ids.has(segment.id) ||
						(segment.linkGroupId && linkedGroups.has(segment.linkGroupId))
					)
			),
		});
		setSelected(null);
	};
	const retryExport = (job: Job) =>
		act(async () => {
			if (!project || job.projectId !== project.id) {
				throw new Error(
					"Select the project that owns this export before retrying."
				);
			}
			if (job.revision !== project.revision) {
				throw new Error(
					"This export belongs to an older revision. Export the current revision instead."
				);
			}
			const next = await request<Job>(`/projects/${project.id}/render`, "POST");
			renderRevision.current += 1;
			renderStates.current[next.id] = next.status;
			setJobs((current) => [next, ...current]);
			setStatus("Retrying the saved timeline export.");
		});
	const newScene = () => {
		if (!project) {
			return;
		}
		edit({
			...project,
			scenes: [
				...project.scenes,
				{
					id: crypto.randomUUID(),
					title: `Scene ${project.scenes.length + 1}`,
					script: "",
					prompt: "",
					assetIds: [],
					duration: 5,
					sourceIn: 0,
					approved: false,
				},
			],
		});
	};

	const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
		if (
			event.target instanceof HTMLElement &&
			event.target.closest(
				"input,textarea,select,[contenteditable=true],[role=dialog]"
			)
		) {
			return;
		}
		if (!project || busy) {
			return;
		}
		const command = event.metaKey || event.ctrlKey;
		if (command && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void act(async () => {
				await save();
			});
		} else if (command && event.key.toLowerCase() === "z") {
			event.preventDefault();
			if (event.shiftKey) {
				redo();
			} else {
				undo();
			}
		} else if (
			event.key === " " &&
			!(event.target instanceof HTMLElement && event.target.closest("button"))
		) {
			event.preventDefault();
			if (time >= duration) {
				setTime(0);
			}
			void resumePreviewAudio()
				.then(() => setPlaying(!playing))
				.catch(() => setStatus("Audio playback is unavailable."));
		} else if (event.key.toLowerCase() === "s" && !command) {
			event.preventDefault();
			split();
		} else if (event.key.toLowerCase() === "d" && !command) {
			event.preventDefault();
			duplicateSelected();
		} else if (event.key.toLowerCase() === "k" && !command) {
			event.preventDefault();
			setPlaying(false);
		} else if (event.key.toLowerCase() === "j" && !command) {
			event.preventDefault();
			setPlaybackDirection(-1);
			void resumePreviewAudio()
				.then(() => setPlaying(true))
				.catch(() => setStatus("Audio playback is unavailable."));
		} else if (event.key.toLowerCase() === "l" && !command) {
			event.preventDefault();
			setPlaybackDirection(1);
			void resumePreviewAudio()
				.then(() => setPlaying(true))
				.catch(() => setStatus("Audio playback is unavailable."));
		} else if (event.key === "Home") {
			event.preventDefault();
			setPlaying(false);
			setPlaybackDirection(1);
			setTime(0);
		} else if (event.key === "End") {
			event.preventDefault();
			setPlaying(false);
			setPlaybackDirection(-1);
			setTime(duration);
		} else if (event.key === "[" && !command && !event.altKey) {
			event.preventDefault();
			navigateMarker(-1);
		} else if (event.key === "]" && !command && !event.altKey) {
			event.preventDefault();
			navigateMarker(1);
		} else if (event.altKey && event.key === "[" && !command) {
			event.preventDefault();
			trimSelectedToPlayhead("start");
		} else if (event.altKey && event.key === "]" && !command) {
			event.preventDefault();
			trimSelectedToPlayhead("end");
		} else if (event.key.toLowerCase() === "i" && !command) {
			event.preventDefault();
			markRangeStart();
		} else if (event.key.toLowerCase() === "o" && !command) {
			event.preventDefault();
			markRangeEnd();
		} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			setPlaying(false);
			const direction = event.key === "ArrowLeft" ? -1 : 1;
			if (event.altKey && selectedSegment) {
				nudgeSelected(direction);
			} else {
				setTime(
					Math.max(
						0,
						Math.min(
							duration,
							time + direction * (event.shiftKey ? 1 : 1 / project.fps)
						)
					)
				);
			}
		} else if (
			(event.key === "Delete" || event.key === "Backspace") &&
			selected &&
			!selectedTrackLocked
		) {
			event.preventDefault();
			edit({
				...project,
				segments: project.segments.filter((segment) => segment.id !== selected),
			});
			setSelected(null);
		}
	});
	useEffect(() => {
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	}, []);

	return (
		<div className="studio-app">
			<RyuAppToolbar className="studio-toolbar">
				<strong>Video Studio</strong>
				<NativeSelect
					aria-label="Project"
					disabled={!ready || busy}
					onChange={(event) => {
						const id = event.target.value;
						void act(async () => {
							if (dirty) {
								await save();
							}
							const next = projectSchema.parse(
								await request(`/projects/${id}`)
							);
							setProject(next);
							setHistory([]);
							setFuture([]);
							setSelected(null);
							setTime(0);
							setRangeStart(0);
							setRangeEnd(1);
							setPlaying(false);
						});
					}}
					value={project?.id ?? ""}
				>
					{!project && (
						<NativeSelectOption value="">Your film library</NativeSelectOption>
					)}
					{projects.map((p) => (
						<NativeSelectOption key={p.id} value={p.id}>
							{p.title}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<RyuAppActions>
					<Button
						disabled={!ready || busy}
						onClick={() => void create()}
						variant="ghost"
					>
						New project
					</Button>
					<Button
						disabled={!project || busy}
						onClick={() => void duplicate()}
						variant="ghost"
					>
						Duplicate project
					</Button>
					<Button
						disabled={!project || busy || !dirty}
						onClick={() =>
							void act(async () => {
								await save();
							})
						}
						variant="outline"
					>
						{dirty ? "Save changes" : "Saved"}
					</Button>
					<Button
						disabled={!(project && duration) || busy}
						onClick={() => void captureFrame()}
						variant="outline"
					>
						Capture frame
					</Button>
					<Button
						disabled={
							!(
								project?.segments.length ||
								project?.titles.length ||
								project?.graphics.length ||
								project?.avatars.length ||
								project?.spatialObjects.length ||
								project?.meshes.length
							) || busy
						}
						onClick={() => void exportVideo()}
					>
						Export video
					</Button>
				</RyuAppActions>
			</RyuAppToolbar>
			<div aria-live="polite" className="studio-status" role="status">
				{status}
			</div>
			{project ? (
				<>
					<div className="studio-workspace" inert={busy}>
						<aside className="studio-library">
							<Tabs onValueChange={setPanel} value={panel}>
								<TabsList>
									<TabsTrigger value="media">Media</TabsTrigger>
									<TabsTrigger value="search">Find footage</TabsTrigger>
									<TabsTrigger value="stock">Stock</TabsTrigger>
									<TabsTrigger value="reference">Reference</TabsTrigger>
									<TabsTrigger value="storyboard">Plan</TabsTrigger>
									<TabsTrigger value="recipes">Recipes</TabsTrigger>
									<TabsTrigger value="layouts">Layouts</TabsTrigger>
									<TabsTrigger value="sync">Sync</TabsTrigger>
									<TabsTrigger value="multicam">Multicam</TabsTrigger>
									<TabsTrigger value="generate">Generate</TabsTrigger>
									<TabsTrigger value="captions">Captions</TabsTrigger>
									<TabsTrigger value="transcript">Transcript</TabsTrigger>
									<TabsTrigger value="titles">Titles</TabsTrigger>
									<TabsTrigger value="graphics">Vector graphics</TabsTrigger>
									<TabsTrigger value="avatars">Avatars</TabsTrigger>
									<TabsTrigger value="stage">3D stage</TabsTrigger>
									<TabsTrigger value="meshes">Meshes</TabsTrigger>
									<TabsTrigger value="credits">Credits</TabsTrigger>
									<TabsTrigger value="exports">Exports</TabsTrigger>
								</TabsList>
							</Tabs>
							{panel === "search" && (
								<SearchPanel
									assets={assets}
									onRange={(assetId, start, end) => {
										const asset = assets.find((item) => item.id === assetId);
										if (!asset) {
											setStatus("The source media is unavailable.");
											return;
										}
										const segment = {
											...newSegment(asset, duration),
											sourceIn: start,
											sourceOut: end,
										};
										edit({
											...project,
											segments: [...project.segments, segment],
										});
										setSelected(segment.id);
										setTime(segment.start);
									}}
									onStatus={setStatus}
								/>
							)}
							{panel === "stock" && (
								<RyuAppSection title="Open media">
									<StockPanel
										onAsset={(asset) => {
											setAssets((current) => [asset, ...current]);
										}}
										onStatus={setStatus}
									/>
								</RyuAppSection>
							)}
							{panel === "reference" && (
								<ReferencePanel
									assets={assets}
									captions={editingCaptions}
									onBrief={(brief) => {
										edit({ ...project, brief });
										setPanel("storyboard");
										setStatus("Reference brief copied to Plan.");
									}}
									onChange={(referenceProfile) =>
										edit({ ...project, referenceProfile })
									}
									onStatus={setStatus}
									profile={project.referenceProfile}
								/>
							)}
							{panel === "media" && (
								<RyuAppSection title="Media library">
									<Button
										disabled={busy}
										onClick={() => picker.current?.click()}
										variant="outline"
									>
										Import media
									</Button>
									<div className="studio-inline-fields">
										<Input
											aria-label="Import media URL"
											disabled={busy}
											onChange={(event) => setImportUrl(event.target.value)}
											placeholder="https://example.com/footage.mp4"
											value={importUrl}
										/>
										<Button
											disabled={busy || !importUrl.trim()}
											onClick={importRemoteMedia}
											variant="outline"
										>
											Import URL
										</Button>
									</div>
									<small>
										HTTPS URLs are probed and copied into app-owned storage.
									</small>
									<SequencePanel
										busy={busy}
										currentProjectId={project.id}
										onCreate={(source) => void createSequenceClip(source)}
										projects={projects}
									/>
									<SoundtrackPanel
										onAsset={(asset) =>
											setAssets((current) => [asset, ...current])
										}
										onStatus={setStatus}
									/>
									<Input
										aria-label="Search media"
										onChange={(e) => setQuery(e.target.value)}
										placeholder="Search your footage…"
										value={query}
									/>
									<NativeSelect
										aria-label="Media folder"
										onChange={(event) => setMediaFolder(event.target.value)}
										value={mediaFolder}
									>
										<NativeSelectOption value="">
											All folders
										</NativeSelectOption>
										{mediaFolders.map((folder) => (
											<NativeSelectOption key={folder} value={folder}>
												{folder}
											</NativeSelectOption>
										))}
									</NativeSelect>
									{!assets.length && (
										<p className="text-muted-foreground">
											Bring in video, music, voice recordings, or still images.
										</p>
									)}
									{assets
										.filter(
											(a) =>
												a.name.toLowerCase().includes(query.toLowerCase()) &&
												(!mediaFolder || a.folder === mediaFolder)
										)
										.map((asset) => (
											<div className="studio-asset" key={asset.id}>
												<div>
													<strong>{asset.name}</strong>
													<small>
														{asset.kind} · {clock(asset.duration)}
														{asset.width
															? ` · ${asset.width} × ${asset.height}`
															: ""}
													</small>
													{asset.folder && (
														<small>Folder: {asset.folder}</small>
													)}
													{asset.origin && (
														<small>
															Source: {asset.origin.provider} ·{" "}
															{asset.origin.attribution}
														</small>
													)}
												</div>
												{asset.kind !== "audio" && (
													<AssetPreview asset={asset} onError={setStatus} />
												)}
												{asset.kind !== "audio" && (
													<ColorScopes asset={asset} onError={setStatus} />
												)}
												{asset.kind !== "audio" && (
													<>
														<Button
															aria-label={`Upscale ${asset.name} 2 times`}
															disabled={busy}
															onClick={() => void upscaleAsset(asset, 2)}
															size="sm"
															variant="ghost"
														>
															2× upscale
														</Button>
														<Button
															aria-label={`Upscale ${asset.name} 4 times`}
															disabled={busy}
															onClick={() => void upscaleAsset(asset, 4)}
															size="sm"
															variant="ghost"
														>
															4× upscale
														</Button>
													</>
												)}
												{asset.sequenceProjectId && (
													<Button
														aria-label={`Refresh ${asset.name}`}
														disabled={busy}
														onClick={() => void refreshSequence(asset)}
														size="sm"
														variant="ghost"
													>
														Refresh sequence
													</Button>
												)}
												<Button
													aria-label={`Add ${asset.name} to timeline`}
													onClick={() => addAsset(asset)}
													size="sm"
													variant="ghost"
												>
													Add
												</Button>
												<AssetOrganization
													asset={asset}
													busy={busy}
													onDelete={() => void organizeAsset(asset, {}, true)}
													onSave={(patch) => void organizeAsset(asset, patch)}
												/>
												{asset.kind !== "image" && (
													<SourceAnalysis
														asset={asset}
														onBeatMarkers={(times) =>
															addBeatMarkers(times, asset.name)
														}
														onError={setStatus}
														onMarkers={(times) =>
															addLoudnessMarkers(times, asset.name)
														}
														onRange={(start, end) => {
															const segment = {
																...newSegment(asset, duration),
																sourceIn: start,
																sourceOut: end,
															};
															edit({
																...project,
																segments: [...project.segments, segment],
															});
															setSelected(segment.id);
															setTime(segment.start);
														}}
														onRemoveSilence={(ranges) =>
															removeDetectedSilence(
																asset.id,
																asset.name,
																ranges
															)
														}
													/>
												)}
											</div>
										))}
								</RyuAppSection>
							)}
							<div hidden={panel !== "transcript"}>
								<TranscriptPanel
									assets={assets}
									onStatus={setStatus}
									onUse={(transcript, highlighted) => {
										const cues = highlighted
											? highlightedCaptionsForSource(project, transcript)
											: captionsForSource(project, transcript);
										if (
											cues.length +
												editingCaptions.filter(
													(cue) => cue.sourceAssetId !== transcript.assetId
												).length >
											5000
										) {
											setStatus(
												"These ranges exceed the 5,000-caption project limit. Shorten the timeline before applying."
											);
											return;
										}
										if (!cues.length) {
											setStatus(
												"Add this source to the timeline before applying its transcript."
											);
											return;
										}
										edit(
											withActiveCaptions(project, [
												...editingCaptions.filter(
													(cue) => cue.sourceAssetId !== transcript.assetId
												),
												...cues,
											])
										);
										setStatus(
											"Source transcript mapped onto the timeline, including trims and speed changes."
										);
									}}
								/>
							</div>
							{panel === "titles" && (
								<TitlesPanel
									onChange={(titles) => edit({ ...project, titles })}
									time={time}
									titles={project.titles}
								/>
							)}
							{panel === "graphics" && (
								<GraphicsPanel
									graphics={project.graphics}
									onChange={(graphics) => edit({ ...project, graphics })}
									styleProfile={project.styleProfile}
									time={time}
								/>
							)}
							{panel === "avatars" && (
								<AvatarPanel
									avatars={project.avatars}
									onChange={(avatars) => edit({ ...project, avatars })}
									time={time}
								/>
							)}
							{panel === "stage" && (
								<StagePanel
									camera={project.stageCamera}
									objects={project.spatialObjects}
									onCameraChange={(stageCamera) =>
										edit({ ...project, stageCamera })
									}
									onChange={(spatialObjects) =>
										edit({ ...project, spatialObjects })
									}
									onWorldChange={({ camera, objects, prompt }) =>
										edit({
											...project,
											spatialObjects: objects,
											stageCamera: camera,
											stageWorldPrompt: prompt,
										})
									}
									onWorldPromptChange={(stageWorldPrompt) =>
										edit({ ...project, stageWorldPrompt })
									}
									time={time}
									worldPrompt={project.stageWorldPrompt ?? ""}
								/>
							)}
							{panel === "meshes" && (
								<MeshPanel
									meshes={project.meshes}
									onChange={(meshes) => edit({ ...project, meshes })}
									onStatus={setStatus}
									time={time}
								/>
							)}
							{panel === "credits" && (
								<CreditsPanel
									onStatus={setStatus}
									projectId={project.id}
									revision={project.revision}
								/>
							)}
							{panel === "generate" && (
								<GenerationPanel
									assets={assets}
									onAsset={(asset) =>
										setAssets((current) => [asset, ...current])
									}
									onStatus={setStatus}
									projectId={project.id}
								/>
							)}
							{panel === "recipes" && (
								<RecipePanel
									assets={assets}
									busy={busy}
									onApply={(recipe) =>
										void act(async () => {
											const saved = dirty ? await save() : project;
											const result = projectSchema.parse(
												await request(`/projects/${saved.id}/recipe`, "POST", {
													...recipe,
													revision: saved.revision,
												})
											);
											setHistory((current) => [...current, project]);
											setFuture([]);
											setProject(result);
											setDirty(false);
											setSelected(null);
											setTime(0);
											setStatus(
												"Recipe applied and saved. Review the timeline before exporting."
											);
										})
									}
								/>
							)}
							{panel === "layouts" && (
								<LayoutPanel
									assets={assets}
									busy={busy}
									onApply={arrangeLayout}
									project={project}
								/>
							)}
							{panel === "sync" && (
								<SyncPanel
									assets={assets}
									busy={busy}
									onSync={syncProject}
									project={project}
								/>
							)}
							{panel === "multicam" && (
								<MulticamPanel
									assets={assets}
									busy={busy}
									onChange={(groupId, entries) =>
										void manageMulticam(
											{
												action: "change",
												entries,
												groupId,
											},
											"Camera angle switched over the selected range."
										)
									}
									onCreate={(input) =>
										void manageMulticam(
											{ action: "create", ...input },
											"Multicam session created with a program-audio track."
										)
									}
									onUngroup={(groupId) =>
										void manageMulticam(
											{ action: "ungroup", groupId },
											"Multicam metadata removed; timeline clips remain editable."
										)
									}
									project={project}
								/>
							)}
							{panel === "storyboard" && (
								<RyuAppSection title="Production plan">
									<ProductionPreflightPanel
										projectId={project.id}
										revision={project.revision}
									/>
									{readiness && (
										<RyuAppSection title="Production readiness">
											<p>
												{readiness.ready
													? "Delivery ready for the current saved revision."
													: readiness.exportReady
														? "Export gate ready. Run a render to complete delivery review."
														: "Resolve the blocked production gates before exporting."}
											</p>
											<ul>
												{readiness.checks.map((check) => (
													<li key={check.id}>
														<strong>{check.label}:</strong> {check.status} ·{" "}
														{check.detail}
													</li>
												))}
											</ul>
										</RyuAppSection>
									)}
									<ProductionActivityPanel
										projectId={project.id}
										revision={project.revision}
									/>
									<DecisionLogPanel
										onAppend={(decision) =>
											edit({
												...project,
												decisions: [...project.decisions, decision],
											})
										}
										project={project}
									/>
									<ResearchSourcesPanel
										onChange={(researchSources) =>
											edit({ ...project, researchSources })
										}
										sources={project.researchSources}
									/>
									<ProductionStagesPanel
										onChange={(next) => edit(next)}
										project={project}
									/>
									<ProductionBudgetPanel
										budget={project.productionBudget}
										onChange={(productionBudget) =>
											edit({ ...project, productionBudget })
										}
										projectId={project.id}
										revision={project.revision}
									/>
									<SceneContactSheet
										assets={assets}
										onStatus={setStatus}
										project={project}
										scenes={project.scenes}
									/>
									<RyuAppField label="Brief">
										<Textarea
											onChange={(e) =>
												edit({ ...project, brief: e.target.value })
											}
											placeholder="What are we making, and who is it for?"
											value={project.brief}
										/>
									</RyuAppField>
									<Button
										disabled={
											busy ||
											drafting ||
											!project.brief.trim() ||
											!window.ryu?.model?.complete
										}
										onClick={() => void draftScenes()}
										variant="outline"
									>
										{drafting ? "Drafting scenes…" : "Draft scenes with Ryu"}
									</Button>
									<Button
										disabled={busy || !project.scenes.length}
										onClick={() =>
											void act(async () => {
												const saved = dirty ? await save() : project;
												const result = projectSchema.parse(
													await request(
														`/projects/${saved.id}/assemble`,
														"POST",
														{ revision: saved.revision, includeTitles: true }
													)
												);
												setHistory((current) => [...current, project]);
												setFuture([]);
												setProject(result);
												setDirty(false);
												setSelected(null);
												setTime(0);
												setStatus(
													"Storyboard assembled into the timeline. Review the edit before exporting."
												);
											})
										}
										variant="outline"
									>
										Assemble storyboard
									</Button>
									<Button onClick={newScene} variant="outline">
										Add scene
									</Button>
									<Button
										onClick={() =>
											edit({
												...project,
												requireApproval: !project.requireApproval,
											})
										}
										variant={project.requireApproval ? "secondary" : "ghost"}
									>
										{project.requireApproval
											? "Scene approval required"
											: "Require scene approval"}
									</Button>
									{project.scenes.map((scene, index) => (
										<div className="studio-scene" key={scene.id}>
											<small>
												Scene {index + 1} ·{" "}
												{sceneReviewLabel(sceneReviewStatus(scene))}
											</small>
											<Input
												aria-label={`Scene ${index + 1} title`}
												onChange={(e) =>
													edit({
														...project,
														scenes: project.scenes.map((s) =>
															s.id === scene.id
																? {
																		...s,
																		title: e.target.value,
																		approved: false,
																		reviewStatus: "in-review",
																	}
																: s
														),
													})
												}
												value={scene.title}
											/>
											<RyuAppField label="Spoken script">
												<Textarea
													aria-label={`Scene ${index + 1} script`}
													maxLength={8000}
													onChange={(e) =>
														edit({
															...project,
															scenes: project.scenes.map((s) =>
																s.id === scene.id
																	? {
																			...s,
																			script: e.target.value,
																			approved: false,
																			reviewStatus: "in-review",
																		}
																	: s
															),
														})
													}
													placeholder="Words for the narrator"
													value={scene.script}
												/>
											</RyuAppField>
											<RyuAppField label="Visual direction">
												<Textarea
													aria-label={`Scene ${index + 1} visual direction`}
													maxLength={8000}
													onChange={(event) =>
														edit({
															...project,
															scenes: project.scenes.map((item) =>
																item.id === scene.id
																	? {
																			...item,
																			prompt: event.target.value,
																			approved: false,
																			reviewStatus: "in-review",
																		}
																	: item
															),
														})
													}
													placeholder="Camera, setting, action, and visual treatment"
													value={scene.prompt}
												/>
											</RyuAppField>
											<RyuAppField label="Review status">
												<NativeSelect
													aria-label={`Scene ${index + 1} review status`}
													disabled={scene.approved}
													onChange={(event) => {
														const reviewStatus = sceneReviewStatusSchema.parse(
															event.target.value
														);
														editedScene(scene.id, {
															reviewStatus,
															approved: false,
														});
													}}
													value={sceneReviewStatus(scene)}
												>
													<NativeSelectOption value="in-review">
														In review
													</NativeSelectOption>
													<NativeSelectOption value="changes-requested">
														Changes requested
													</NativeSelectOption>
													<NativeSelectOption disabled value="approved">
														Approved by review action
													</NativeSelectOption>
												</NativeSelect>
											</RyuAppField>
											<RyuAppField label="Review note">
												<Textarea
													aria-label={`Scene ${index + 1} review note`}
													disabled={scene.approved}
													maxLength={2000}
													onChange={(event) =>
														editedScene(scene.id, {
															reviewNotes: event.target.value,
														})
													}
													placeholder="What needs to change before approval?"
													value={scene.reviewNotes ?? ""}
												/>
											</RyuAppField>
											{scene.approved && (
												<small>Reopen review to edit this note.</small>
											)}

											<SceneMedia
												assets={assets}
												index={index}
												onChange={(next) =>
													edit({
														...project,
														scenes: project.scenes.map((item) =>
															item.id === scene.id ? next : item
														),
													})
												}
												onError={setStatus}
												scene={scene}
											/>
											<Button
												disabled={!scene.assetIds.length || busy}
												onClick={() =>
													void act(async () => {
														const saved = dirty ? await save() : project;
														const result = projectSchema.parse(
															await request(
																`/projects/${project.id}/approve-scene`,
																"POST",
																{
																	sceneId: scene.id,
																	revision: saved.revision,
																	approved: !scene.approved,
																}
															)
														);
														setProject(result);
														setDirty(false);
														setStatus("Scene approval saved.");
													})
												}
												size="sm"
												variant="outline"
											>
												{scene.approved ? "Reopen review" : "Approve scene"}
											</Button>
										</div>
									))}
								</RyuAppSection>
							)}
							{panel === "captions" && (
								<RyuAppSection title="Timed captions">
									<RyuAppField label="Caption track">
										<NativeSelect
											aria-label="Caption track"
											onChange={(event) =>
												edit({
													...project,
													captionTrackId: event.target.value || null,
												})
											}
											value={project.captionTrackId ?? ""}
										>
											<NativeSelectOption value="">
												Source captions
											</NativeSelectOption>
											{project.captionTracks.map((track) => (
												<NativeSelectOption key={track.id} value={track.id}>
													{track.label} · {track.language}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</RyuAppField>
									<TranslateCaptions
										captions={editingCaptions}
										onApply={(original, translated, language) => {
											const current = latestProject.current;
											if (
												!current ||
												current.id !== project.id ||
												JSON.stringify(activeCaptions(current)) !==
													JSON.stringify(original)
											) {
												throw new Error(
													"The captions changed during translation. Your current edit was kept; try again."
												);
											}
											setHistory((history) => [...history.slice(-99), current]);
											setFuture([]);
											const existing = current.captionTracks.find(
												(track) =>
													track.language.toLowerCase() ===
													language.toLowerCase()
											);
											const trackId = existing?.id ?? crypto.randomUUID();
											setProject({
												...current,
												captionTracks: existing
													? current.captionTracks.map((track) =>
															track.id === existing.id
																? { ...track, captions: translated }
																: track
														)
													: [
															...current.captionTracks,
															{
																captions: translated,
																id: trackId,
																label: language,

																language,
															},
														],
												captionTrackId: trackId,
											});
											setDirty(true);
										}}
										onStatus={setStatus}
									/>
									<DubCaptions
										captions={editingCaptions}
										onAsset={(asset) => {
											setAssets((current) => [asset, ...current]);
											addAsset(asset);
										}}
										onStatus={setStatus}
										projectId={project.id}
									/>
									<RyuAppActions>
										<Button
											onClick={() => captionPicker.current?.click()}
											size="sm"
											variant="outline"
										>
											Import SRT / VTT
										</Button>
										<Button
											onClick={() =>
												editCaptions([
													...editingCaptions,
													{
														id: crypto.randomUUID(),
														start: time,
														end: Math.min(7200, time + 3),
														text: "New caption",
													},
												])
											}
											size="sm"
											variant="ghost"
										>
											Add caption
										</Button>
									</RyuAppActions>
									{editingCaptions.map((cue, index) => (
										<div className="studio-scene" key={cue.id}>
											<Button
												onClick={() => setTime(cue.start)}
												size="sm"
												variant="ghost"
											>
												{clock(cue.start)} → {clock(cue.end)}
											</Button>
											{cue.words?.length ? (
												<RyuAppField label="Word highlight color">
													<ColorPickerPopover
														onValueChange={(value) =>
															editCaptions(
																editingCaptions.map((c) =>
																	c.id === cue.id
																		? { ...c, highlightColor: value }
																		: c
																)
															)
														}
														triggerAriaLabel={`Caption ${index + 1} highlight color`}
														triggerClassName="w-full justify-start"
														value={cue.highlightColor ?? "#ffd43b"}
													/>
												</RyuAppField>
											) : null}
											<Textarea
												aria-label={`Caption ${index + 1}`}
												onChange={(e) =>
													editCaptions(
														editingCaptions.map((c) =>
															c.id === cue.id
																? {
																		...c,
																		text: e.target.value,
																		words: undefined,
																	}
																: c
														)
													)
												}
												value={cue.text}
											/>
											<div className="studio-pair">
												<NumberField
													label="Caption start"
													max={7200}
													min={0}
													onChange={(start) =>
														editCaptions(
															editingCaptions.map((c) =>
																c.id === cue.id
																	? { ...c, start, words: undefined }
																	: c
															)
														)
													}
													value={cue.start}
												/>
												<NumberField
													label="Caption end"
													max={7200}
													min={0}
													onChange={(end) =>
														editCaptions(
															editingCaptions.map((c) =>
																c.id === cue.id
																	? { ...c, end, words: undefined }
																	: c
															)
														)
													}
													value={cue.end}
												/>
											</div>
											<Button
												onClick={() =>
													editCaptions(
														editingCaptions.filter((c) => c.id !== cue.id)
													)
												}
												size="sm"
												variant="ghost"
											>
												Remove caption
											</Button>
										</div>
									))}
									<Button
										disabled={!editingCaptions.length}
										onClick={() =>
											download(
												new Blob([subtitleText(editingCaptions, "srt")], {
													type: "text/plain",
												}),
												`${project.title}.srt`
											)
										}
										variant="outline"
									>
										Download subtitles
									</Button>
								</RyuAppSection>
							)}
							{panel === "exports" && (
								<RyuAppSection title="Export history">
									{!jobs.some((j) => j.projectId === project.id) && (
										<p className="text-muted-foreground">
											Your finished videos will appear here.
										</p>
									)}
									{jobs
										.filter((j) => j.projectId === project.id)
										.map((job) => (
											<div className="studio-scene" key={job.id}>
												<small>
													Saved version {job.revision} · {job.codec ?? "h264"}
												</small>
												<strong>
													{job.status === "running"
														? job.progress < 0.9
															? "Encoding video…"
															: "Checking output…"
														: job.status}
												</strong>
												{job.error && <p>{job.error}</p>}
												{job.review && (
													<>
														<small>
															{job.review.width} × {job.review.height} ·{" "}
															{job.review.frameRate
																? `${job.review.frameRate} fps · `
																: ""}
															{clock(job.review.duration)} ·{" "}
															{(job.review.bytes / 1e6).toFixed(1)} MB
															{job.review.hasAudio ? " · Audio" : ""}
														</small>
														<details>
															<summary>
																Delivery review ·{" "}
																{job.review.checks
																	? job.review.passed
																		? "Passed"
																		: "Needs review"
																	: "Legacy metadata"}
															</summary>
															{job.review.checks ? (
																<ul>
																	{job.review.checks.map((check) => (
																		<li key={check.id}>
																			<strong>{check.label}:</strong>{" "}
																			{check.message}
																		</li>
																	))}
																</ul>
															) : (
																<p>
																	This export predates delivery review checks.
																</p>
															)}
														</details>
													</>
												)}
												{["pending", "running"].includes(job.status) && (
													<Button
														onClick={() =>
															void act(async () => {
																await request(
																	`/renders/${job.id}/cancel`,
																	"POST"
																);
															})
														}
														size="sm"
														variant="outline"
													>
														Cancel export
													</Button>
												)}
												{["failed", "canceled"].includes(job.status) &&
													job.revision === project.revision && (
														<Button
															disabled={busy}
															onClick={() => void retryExport(job)}
															size="sm"
															variant="outline"
														>
															Retry export
														</Button>
													)}
												{job.status === "completed" && (
													<Button
														disabled={busy}
														onClick={() =>
															void act(async () => {
																const format = exportFormat(job.codec);
																download(
																	await mediaBlob(
																		`/renders/${job.id}/data`,
																		format.mime
																	),
																	`${project.title}.${format.extension}`
																);
																setStatus("Rendered video downloaded.");
															})
														}
														size="sm"
													>
														Download {exportFormat(job.codec).label}
													</Button>
												)}
											</div>
										))}
								</RyuAppSection>
							)}
						</aside>
						<main className="studio-stage">
							<div className="studio-stage-heading">
								<span>{project.title}</span>
								<span>
									{project.width} × {project.height} · {project.fps} fps
								</span>
							</div>
							<div className="studio-preview">
								<Preview
									assets={assets}
									onError={setStatus}
									playing={playing}
									project={project}
									sources={sources}
									time={time}
								/>
								{!(
									project.segments.length ||
									project.titles.length ||
									project.graphics.length ||
									project.avatars.length ||
									project.spatialObjects.length ||
									project.meshes.length
								) && (
									<p className="studio-preview-empty">
										Add media, graphics, an avatar, a mesh, or a 3D block to
										start your timeline
									</p>
								)}
							</div>
							<div className="studio-playback">
								<Button
									aria-label={playing ? "Pause playback" : "Play timeline"}
									disabled={!duration}
									onClick={() => {
										if (time >= duration) {
											setTime(0);
										}
										setPlaybackDirection(1);
										void resumePreviewAudio()
											.then(() => setPlaying(!playing))
											.catch(() => setStatus("Audio playback is unavailable."));
									}}
									variant="ghost"
								>
									{playing ? "Pause" : "Play"}
								</Button>
								<span className="font-mono">
									{clock(time)} / {clock(duration)}
								</span>
							</div>
						</main>
						<aside className="studio-inspector">
							<RyuAppSection
								aria-disabled={selectedTrackLocked || undefined}
								inert={selectedTrackLocked || undefined}
								title={selectedSegment ? "Clip inspector" : "Project settings"}
							>
								{selectedSegment ? (
									<>
										{selectedTrackLocked && (
											<small>
												Track locked · unlock it from the timeline header to
												edit.
											</small>
										)}
										<strong>
											{
												assets.find((a) => a.id === selectedSegment.assetId)
													?.name
											}
										</strong>
										<RyuAppActions>
											{selectedSegment.linkGroupId ? (
												<Button
													onClick={() => {
														if (!project) {
															return;
														}
														try {
															edit(
																manageClipLinks(project, assets, {
																	action: "unlink",
																	clipIds: [selectedSegment.id],
																	revision: project.revision,
																})
															);
														} catch (error) {
															setStatus(message(error));
														}
													}}
													size="sm"
													variant="outline"
												>
													Unlink audio/video
												</Button>
											) : (
												<Button
													disabled={!linkCandidate}
													onClick={() => {
														if (
															!(project && selectedSegment && linkCandidate)
														) {
															return;
														}
														try {
															edit(
																manageClipLinks(project, assets, {
																	action: "link",
																	clipIds: [
																		selectedSegment.id,
																		linkCandidate.id,
																	],
																	revision: project.revision,
																})
															);
														} catch (error) {
															setStatus(message(error));
														}
													}}
													size="sm"
													variant="outline"
												>
													Link overlapping audio/video
												</Button>
											)}
										</RyuAppActions>
										{(
											[
												["start", "Timeline start", 0, 7200],
												["sourceIn", "Source in", 0, 7200],
												["sourceOut", "Source out", 0, 7200],
												["track", "Track", 0, 15],
												["speed", "Speed", 0.25, 4],
												["volume", "Volume", 0, 4],
												["scale", "Scale", 0.1, 4],
												["x", "Horizontal position", -1, 1],
												["y", "Vertical position", -1, 1],
												["opacity", "Opacity", 0, 1],
												["brightness", "Brightness", -1, 1],
												["contrast", "Contrast", 0, 3],
												["saturation", "Saturation", 0, 3],
												["rotation", "Rotation", -180, 180],
												["fadeIn", "Fade in", 0, 7200],
												["fadeOut", "Fade out", 0, 7200],
											] as const
										)
											.filter(
												([key]) =>
													visualControls ||
													[
														"start",
														"sourceIn",
														"sourceOut",
														"track",
														"speed",
														"volume",
														"fadeIn",
														"fadeOut",
													].includes(key)
											)
											.map(([key, label, min, max]) => (
												<NumberField
													key={key}
													label={label}
													max={key === "track" ? 16 : max}
													min={key === "track" ? 1 : min}
													onChange={(value) =>
														changeSegment({
															[key]: key === "track" ? value - 1 : value,
														})
													}
													step={key === "track" ? 1 : 0.05}
													value={
														key === "track"
															? selectedSegment.track + 1
															: selectedSegment[key]
													}
												/>
											))}
										{visualControls && (
											<>
												<RyuAppField label="Crop edges">
													<div className="studio-inline-fields">
														{(["top", "right", "bottom", "left"] as const).map(
															(edge) => (
																<NumberField
																	key={edge}
																	label={edge}
																	max={0.9}
																	min={0}
																	onChange={(value) =>
																		changeSegment({
																			crop: {
																				...selectedSegment.crop,
																				[edge]: value,
																			},
																		})
																	}
																	step={0.01}
																	value={selectedSegment.crop[edge]}
																/>
															)
														)}
													</div>
												</RyuAppField>
												<RyuAppField label="Edge shape">
													<div className="studio-inline-fields">
														<NumberField
															label="Rounding (%)"
															max={50}
															min={0}
															onChange={(value) =>
																changeSegment({ edgeRounding: value / 100 })
															}
															step={1}
															value={selectedSegment.edgeRounding * 100}
														/>
														<NumberField
															label="Softness (px)"
															max={80}
															min={0}
															onChange={(value) =>
																changeSegment({ edgeSoftness: value })
															}
															step={1}
															value={selectedSegment.edgeSoftness}
														/>
													</div>
												</RyuAppField>
												<RyuAppField label="Color grade">
													<div className="studio-inline-fields">
														{(
															[
																["exposure", "Exposure", -3, 3],
																["temperature", "Temperature", -1, 1],
																["tint", "Tint", -1, 1],
																["vibrance", "Vibrance", -1, 1],
															] as const
														).map(([key, label, min, max]) => (
															<NumberField
																key={key}
																label={label}
																max={max}
																min={min}
																onChange={(value) =>
																	changeSegment({
																		colorGrade: {
																			...selectedSegment.colorGrade,
																			[key]: value,
																		},
																	})
																}
																step={0.05}
																value={selectedSegment.colorGrade[key]}
															/>
														))}
													</div>
												</RyuAppField>
												<RyuAppField label="Visual effect">
													<NativeSelect
														aria-label="Visual effect"
														onChange={(event) =>
															changeSegment({
																visualEffect: event.target
																	.value as Segment["visualEffect"],
															})
														}
														value={selectedSegment.visualEffect ?? "none"}
													>
														<NativeSelectOption value="none">
															Original look
														</NativeSelectOption>
														<NativeSelectOption value="blur">
															Soft blur
														</NativeSelectOption>
														<NativeSelectOption value="grayscale">
															Grayscale
														</NativeSelectOption>
														<NativeSelectOption value="sepia">
															Sepia
														</NativeSelectOption>
													</NativeSelect>
												</RyuAppField>
												<RyuAppField label="Effect stack">
													<NativeSelect
														aria-label="Effect stack"
														onChange={(event) => {
															const value = event.target.value as
																| "blur"
																| "grayscale"
																| "none"
																| "sepia"
																| "sharpen"
																| "vignette";
															changeSegment({
																effects:
																	value === "none"
																		? []
																		: selectedSegment.effects.some(
																					(effect) => effect.type === value
																				)
																			? selectedSegment.effects
																			: [
																					...selectedSegment.effects,
																					{
																						amount: 1,
																						enabled: true,
																						type: value,
																					},
																				],
															});
														}}
														value={
															selectedSegment.effects.length === 1
																? selectedSegment.effects[0]?.type
																: "none"
														}
													>
														<NativeSelectOption value="none">
															None
														</NativeSelectOption>
														<NativeSelectOption value="blur">
															Blur
														</NativeSelectOption>
														<NativeSelectOption value="grayscale">
															Grayscale
														</NativeSelectOption>
														<NativeSelectOption value="sepia">
															Sepia
														</NativeSelectOption>
														<NativeSelectOption value="sharpen">
															Sharpen
														</NativeSelectOption>
														<NativeSelectOption value="vignette">
															Vignette
														</NativeSelectOption>
													</NativeSelect>
													{selectedSegment.effects.length > 0 ? (
														<div className="studio-inline-fields">
															{selectedSegment.effects.map((effect, index) => (
																<div
																	className="studio-inline-fields"
																	key={`${effect.type}-${index}`}
																>
																	<NumberField
																		label={`${effect.type} amount (%)`}
																		max={100}
																		min={0}
																		onChange={(value) =>
																			changeSegment({
																				effects: selectedSegment.effects.map(
																					(existing, existingIndex) =>
																						existingIndex === index
																							? {
																									...existing,
																									amount: value / 100,
																								}
																							: existing
																				),
																			})
																		}
																		step={1}
																		value={effect.amount * 100}
																	/>
																	<Button
																		aria-label={`Remove ${effect.type} effect`}
																		onClick={() =>
																			changeSegment({
																				effects: selectedSegment.effects.filter(
																					(_, effectIndex) =>
																						effectIndex !== index
																				),
																			})
																		}
																		size="sm"
																		variant="ghost"
																	>
																		Remove
																	</Button>
																</div>
															))}
														</div>
													) : null}
												</RyuAppField>
												<RyuAppField label="Entry transition">
													<NativeSelect
														aria-label="Entry transition"
														onChange={(event) =>
															changeSegment({
																entryTransition: event.target
																	.value as Segment["entryTransition"],
																entryOffset: 0,
															})
														}
														value={selectedSegment.entryTransition}
													>
														<NativeSelectOption value="none">
															None
														</NativeSelectOption>
														<NativeSelectOption value="crossfade">
															Crossfade
														</NativeSelectOption>
														<NativeSelectOption value="zoom-in">
															Zoom in
														</NativeSelectOption>
														<NativeSelectOption value="zoom-out">
															Zoom out
														</NativeSelectOption>
														<NativeSelectOption value="slide-left">
															Slide left
														</NativeSelectOption>
														<NativeSelectOption value="slide-right">
															Slide right
														</NativeSelectOption>
														<NativeSelectOption value="slide-up">
															Slide up
														</NativeSelectOption>
														<NativeSelectOption value="slide-down">
															Slide down
														</NativeSelectOption>
													</NativeSelect>
												</RyuAppField>
												{selectedSegment.entryTransition !== "none" && (
													<NumberField
														label="Transition seconds"
														max={30}
														min={0}
														onChange={(value) =>
															changeSegment({
																entryDuration: value,
																entryOffset: 0,
															})
														}
														step={0.05}
														value={selectedSegment.entryDuration}
													/>
												)}
											</>
										)}
										{selectedIsAudio && (
											<>
												<RyuAppField label="Audio processing">
													<NativeSelect
														aria-label="Audio processing"
														onChange={(event) =>
															changeSegment({
																audioProcessing: event.target
																	.value as Segment["audioProcessing"],
															})
														}
														value={selectedSegment.audioProcessing ?? "none"}
													>
														<NativeSelectOption value="none">
															Original audio
														</NativeSelectOption>
														<NativeSelectOption value="denoise">
															Noise reduction
														</NativeSelectOption>
														<NativeSelectOption value="normalize">
															Normalize loudness
														</NativeSelectOption>
														<NativeSelectOption value="voice-enhance">
															Voice enhance
														</NativeSelectOption>
													</NativeSelect>
												</RyuAppField>
												<RyuAppField label="Duck under other audio">
													<NativeSelect
														aria-label="Duck under other audio"
														onChange={(event) =>
															changeSegment({
																duckUnderVoice: event.target.value === "yes",
															})
														}
														value={
															selectedSegment.duckUnderVoice ? "yes" : "no"
														}
													>
														<NativeSelectOption value="no">
															Keep full mix
														</NativeSelectOption>
														<NativeSelectOption value="yes">
															Duck under voice
														</NativeSelectOption>
													</NativeSelect>
												</RyuAppField>
												<RyuAppField label="Audio visualization">
													<NativeSelect
														aria-label="Audio visualization"
														onChange={(event) =>
															changeSegment({
																visualization: event.target
																	.value as Segment["visualization"],
																...(event.target.value === "waveform" &&
																selectedSegment.visualization === "none" &&
																selectedSegment.y === 0
																	? { y: 0.35 }
																	: {}),
															})
														}
														value={selectedSegment.visualization}
													>
														<NativeSelectOption value="none">
															None
														</NativeSelectOption>
														<NativeSelectOption value="waveform">
															Waveform
														</NativeSelectOption>
													</NativeSelect>
												</RyuAppField>
												{selectedSegment.visualization === "waveform" && (
													<>
														{" "}
														<RyuAppField label="Waveform color">
															<ColorPickerPopover
																onValueChange={(value) =>
																	changeSegment({ waveformColor: value })
																}
																triggerAriaLabel="Waveform color"
																triggerClassName="w-full justify-start"
																value={selectedSegment.waveformColor}
															/>
														</RyuAppField>
														<NumberField
															label="Waveform height (%)"
															max={100}
															min={5}
															onChange={(value) =>
																changeSegment({ waveformHeight: value / 100 })
															}
															step={1}
															value={selectedSegment.waveformHeight * 100}
														/>
													</>
												)}
											</>
										)}
										<RyuAppSection title="Animation">
											<NativeSelect
												aria-label="Animation property"
												onChange={(e) =>
													setAnimationProperty(
														e.target.value as Keyframe["property"]
													)
												}
												value={animationMode}
											>
												{visualControls && (
													<>
														{" "}
														<NativeSelectOption value="scale">
															Scale
														</NativeSelectOption>
														<NativeSelectOption value="x">
															Horizontal position
														</NativeSelectOption>
														<NativeSelectOption value="y">
															Vertical position
														</NativeSelectOption>
														<NativeSelectOption value="rotation">
															Rotation
														</NativeSelectOption>
														<NativeSelectOption value="opacity">
															Opacity
														</NativeSelectOption>
													</>
												)}
												<NativeSelectOption value="volume">
													Volume
												</NativeSelectOption>
											</NativeSelect>
											<Button
												disabled={
													time < selectedSegment.start ||
													time >
														selectedSegment.start +
															segmentDuration(selectedSegment)
												}
												onClick={() => {
													const localTime = Number(
														(time - selectedSegment.start).toFixed(3)
													);
													const frame = {
														id: crypto.randomUUID(),
														property: animationMode,
														time: localTime,
														value: selectedSegment[animationMode],
													};
													changeSegment({
														keyframes: [
															...selectedSegment.keyframes.filter(
																(f) =>
																	!(
																		f.property === animationMode &&
																		f.time === localTime
																	)
															),
															frame,
														],
													});
												}}
												size="sm"
												variant="outline"
											>
												Add keyframe
											</Button>
											{selectedSegment.keyframes
												.filter((f) => f.property === animationMode)
												.sort((a, b) => a.time - b.time)
												.map((frame) => (
													<div className="studio-scene" key={frame.id}>
														<Button
															onClick={() =>
																setTime(selectedSegment.start + frame.time)
															}
															size="sm"
															variant="ghost"
														>
															{clock(frame.time)}
														</Button>
														<NumberField
															label={`${frame.property} at ${frame.time}s`}
															max={
																frame.property === "x" ||
																frame.property === "y" ||
																frame.property === "opacity"
																	? 1
																	: frame.property === "rotation"
																		? 180
																		: 4
															}
															min={
																frame.property === "scale"
																	? 0.1
																	: frame.property === "volume" ||
																			frame.property === "opacity"
																		? 0
																		: frame.property === "rotation"
																			? -180
																			: -1
															}
															onChange={(value) =>
																changeSegment({
																	keyframes: selectedSegment.keyframes.map(
																		(f) =>
																			f.id === frame.id ? { ...f, value } : f
																	),
																})
															}
															value={frame.value}
														/>
														<Button
															onClick={() =>
																changeSegment({
																	keyframes: selectedSegment.keyframes.filter(
																		(f) => f.id !== frame.id
																	),
																})
															}
															size="sm"
															variant="ghost"
														>
															Remove keyframe
														</Button>
													</div>
												))}
										</RyuAppSection>
										<Button onClick={() => setSelected(null)} variant="ghost">
											Project settings
										</Button>
									</>
								) : (
									<>
										<RyuAppField label="Title">
											<Input
												onChange={(e) =>
													edit({ ...project, title: e.target.value })
												}
												value={project.title}
											/>
										</RyuAppField>
										<RyuAppField label="Format">
											<NativeSelect
												aria-label="Output format"
												onChange={(e) => {
													const [width, height] = e.target.value
														.split("x")
														.map(Number);
													if (width && height) {
														edit({ ...project, width, height });
													}
												}}
												value={`${project.width}x${project.height}`}
											>
												<NativeSelectOption value="1920x1080">
													Landscape · 1080p
												</NativeSelectOption>
												<NativeSelectOption value="1080x1920">
													Vertical · 1080p
												</NativeSelectOption>
												<NativeSelectOption value="1080x1080">
													Square · 1080p
												</NativeSelectOption>
												<NativeSelectOption value="1280x720">
													Landscape · 720p
												</NativeSelectOption>
												<NativeSelectOption value="3840x2160">
													Landscape · 4K
												</NativeSelectOption>
												<NativeSelectOption value="640x360">
													Preview · 360p
												</NativeSelectOption>
											</NativeSelect>
										</RyuAppField>
										<RyuAppField label="Frame rate">
											<NativeSelect
												aria-label="Frame rate"
												onChange={(e) =>
													edit({
														...project,
														fps: Number(e.target.value) as Project["fps"],
													})
												}
												value={project.fps}
											>
												{[24, 25, 30, 60].map((fps) => (
													<NativeSelectOption key={fps} value={fps}>
														{fps} fps
													</NativeSelectOption>
												))}
											</NativeSelect>
										</RyuAppField>
										<RyuAppField label="Video codec">
											<NativeSelect
												aria-label="Video codec"
												onChange={(event) =>
													edit({
														...project,
														exportCodec: event.target
															.value as Project["exportCodec"],
													})
												}
												value={project.exportCodec}
											>
												<NativeSelectOption value="h264">
													H.264 · MP4
												</NativeSelectOption>
												<NativeSelectOption value="h265">
													H.265 · HEVC
												</NativeSelectOption>
												<NativeSelectOption value="prores">
													ProRes 422 · MOV
												</NativeSelectOption>
											</NativeSelect>
										</RyuAppField>
										<RyuAppField label="Export preset">
											<NativeSelect
												aria-label="Export preset"
												onChange={(event) =>
													edit({
														...project,
														exportPreset: event.target
															.value as Project["exportPreset"],
													})
												}
												value={project.exportPreset}
											>
												<NativeSelectOption value="master">
													Master · high quality
												</NativeSelectOption>
												<NativeSelectOption value="review">
													Review · smaller file
												</NativeSelectOption>
												<NativeSelectOption value="social">
													Social · balanced
												</NativeSelectOption>
											</NativeSelect>
										</RyuAppField>
										<RyuAppField label="Visual style">
											<NativeSelect
												aria-label="Visual style"
												onChange={(event) =>
													edit({
														...project,
														styleProfile: event.target
															.value as Project["styleProfile"],
													})
												}
												value={project.styleProfile}
											>
												{styleProfileOptions().map((option) => (
													<NativeSelectOption
														key={option.value}
														value={option.value}
													>
														{option.label}
													</NativeSelectOption>
												))}
											</NativeSelect>
											<small>
												{styleProfileConfig(project.styleProfile).description}
											</small>
										</RyuAppField>
										<Button
											onClick={() =>
												download(
													new Blob([JSON.stringify(project, null, 2)], {
														type: "application/json",
													}),
													`${project.title}.json`
												)
											}
											variant="outline"
										>
											Download project JSON
										</Button>
										<Button
											disabled={busy}
											onClick={() => void downloadInterchange("fcpxml")}
											variant="outline"
										>
											Download FCPXML
										</Button>
										<Button
											disabled={busy}
											onClick={() => void downloadInterchange("xmeml")}
											variant="outline"
										>
											Download Premiere XML
										</Button>
										<Button
											onClick={() =>
												void request<unknown>(`/projects/${project.id}/package`)
													.then((bundle) => {
														download(
															new Blob([JSON.stringify(bundle, null, 2)], {
																type: "application/json",
															}),
															`${project.title}.ryu-video-package.json`
														);
														setStatus("Production package downloaded.");
													})
													.catch((error) => setStatus(message(error)))
											}
											variant="outline"
										>
											Download production package
										</Button>
										<input
											accept=".json,application/json"
											hidden
											onChange={(event) => {
												const file = event.target.files?.[0];
												if (file) {
													void importPackage(file).catch((error) =>
														setStatus(message(error))
													);
												}
												event.target.value = "";
											}}
											ref={packagePicker}
											type="file"
										/>
										<Button
											onClick={() => packagePicker.current?.click()}
											variant="outline"
										>
											Import production package
										</Button>
									</>
								)}
							</RyuAppSection>
						</aside>
					</div>
					<section
						aria-label="Video timeline"
						className="studio-timeline"
						inert={busy}
					>
						<div className="studio-timeline-toolbar">
							<RyuAppActions>
								<Button
									disabled={!history.length}
									onClick={undo}
									size="sm"
									variant="ghost"
								>
									Undo
								</Button>
								<Button
									disabled={!future.length}
									onClick={redo}
									size="sm"
									variant="ghost"
								>
									Redo
								</Button>
								<Button
									disabled={!selectedSegment || selectedTrackLocked}
									onClick={split}
									size="sm"
									variant="outline"
								>
									Split at playhead
								</Button>
								<Button
									disabled={!selectedSegment || selectedTrackLocked}
									onClick={duplicateSelected}
									size="sm"
									variant="ghost"
								>
									Duplicate
								</Button>
								<Button
									aria-label="Insert selected clip at playhead"
									disabled={!selectedSegment || selectedTrackLocked}
									onClick={insertSelectedAtPlayhead}
									size="sm"
									variant="outline"
								>
									Insert
								</Button>
								<Button
									disabled={!selectedSegment || selectedTrackLocked}
									onClick={deleteSelected}
									size="sm"
									variant="ghost"
								>
									{selectedIds.length > 1
										? `Delete ${selectedIds.length} clips`
										: "Delete clip"}
								</Button>
							</RyuAppActions>
							{selectedIds.length > 1 && (
								<small>
									{selectedIds.length} timeline clips selected · Shift-click to
									toggle
								</small>
							)}
							<div className="studio-marker-controls">
								<Input
									aria-label="Marker label"
									maxLength={120}
									onChange={(event) => setMarkerLabel(event.target.value)}
									placeholder="Marker label"
									value={markerLabel}
								/>
								<ColorPickerPopover
									onValueChange={setMarkerColor}
									triggerAriaLabel="Marker color"
									triggerClassName="h-9 w-14 shrink-0 p-1"
									triggerShowValue={false}
									value={markerColor}
								/>
								<Button onClick={addMarker} size="sm" variant="outline">
									Add marker
								</Button>
							</div>
							{project.markers.length > 0 && (
								<details className="studio-marker-list">
									<summary>
										{project.markers.length} timeline marker
										{project.markers.length === 1 ? "" : "s"}
									</summary>
									{project.markers.map((marker) => (
										<div className="studio-marker-row" key={marker.id}>
											<span
												aria-hidden="true"
												className="studio-marker-swatch"
												style={{
													backgroundColor: marker.color ?? defaultMarkerColor,
												}}
											/>
											<Button
												onClick={() => setTime(marker.time)}
												size="sm"
												variant="ghost"
											>
												{marker.label} · {clock(marker.time)}
												{marker.duration
													? `–${clock(marker.time + marker.duration)}`
													: ""}
											</Button>
											{(marker.status || marker.comment) && (
												<small>
													{marker.status ?? "open"}
													{marker.comment ? ` · ${marker.comment}` : ""}
												</small>
											)}
											<Button
												aria-label={`Remove marker ${marker.label}`}
												onClick={() => removeMarker(marker.id)}
												size="sm"
												variant="ghost"
											>
												Remove
											</Button>
										</div>
									))}
								</details>
							)}
							<NumberField
								label="Playhead"
								max={Math.max(duration, 1)}
								min={0}
								onChange={setTime}
								onFocus={() => setPlaying(false)}
								value={time}
							/>
							<NativeSelect
								aria-label="Timeline zoom"
								onChange={(e) => setZoom(Number(e.target.value))}
								value={zoom}
							>
								{[20, 40, 70, 120].map((value) => (
									<NativeSelectOption key={value} value={value}>
										{value}px / sec
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
						<div className="studio-range-toolbar">
							<strong>Range edit</strong>
							<NumberField
								label="Range start"
								max={Math.max(duration, 0.04)}
								min={0}
								onChange={setRangeStart}
								value={rangeStart}
							/>
							<NumberField
								label="Range end"
								max={Math.max(duration, 0.04)}
								min={0}
								onChange={setRangeEnd}
								value={rangeEnd}
							/>
							<Button
								disabled={
									busy || duration < 0.04 || rangeEnd - rangeStart < 0.04
								}
								onClick={deleteRange}
								size="sm"
								variant="outline"
							>
								Ripple delete range
							</Button>
							<small>
								Shifts later clips, captions, and timed layers left.
							</small>
						</div>
						<div className="studio-timeline-scroll">
							<div
								className="studio-tracks"
								style={{ width: Math.max(640, (duration + 3) * zoom) }}
							>
								<div className="studio-ruler">
									{project.markers.map((marker) => (
										<Button
											aria-label={`Marker ${marker.label} at ${clock(marker.time)}${marker.duration ? ` through ${clock(marker.time + marker.duration)}` : ""}`}
											className="studio-marker"
											data-compact={
												marker.label.startsWith("Peak ") ||
												marker.label.startsWith("Beat ")
													? "true"
													: undefined
											}
											key={marker.id}
											onClick={() => setTime(marker.time)}
											size="sm"
											style={{
												borderColor: marker.color ?? defaultMarkerColor,
												left: marker.time * zoom,
												...(marker.duration
													? { width: Math.max(1, marker.duration * zoom) }
													: {}),
											}}
											title={`${marker.label} · ${clock(marker.time)}${marker.duration ? `–${clock(marker.time + marker.duration)}` : ""}${marker.comment ? ` · ${marker.comment}` : ""}`}
											variant="ghost"
										>
											{rulerMarkerLabel(marker.label)}
										</Button>
									))}
									{Array.from(
										{ length: Math.min(1000, Math.ceil(duration + 4)) },
										(_, index) => (
											<Button
												key={index}
												onClick={() => setTime(Math.min(index, duration))}
												size="sm"
												style={{ position: "absolute", left: index * zoom }}
												variant="ghost"
											>
												{index}s
											</Button>
										)
									)}
								</div>
								{trackOrderFor(project).map((track, index, order) => {
									const setting = trackSettingFor(project, track);
									return (
										<div
											className="studio-track"
											data-locked={setting.locked ? "true" : undefined}
											data-muted={setting.muted ? "true" : undefined}
											key={track}
										>
											<div className="studio-track-label">
												<Input
													aria-label={`Track ${track + 1} name`}
													defaultValue={setting.name}
													key={`${track}:${setting.name}`}
													onBlur={(event) =>
														renameTrack(track, event.target.value)
													}
													placeholder={`Track ${track + 1}`}
												/>
												<div className="studio-track-controls">
													<Button
														aria-label={`Move ${setting.name} down`}
														disabled={index === 0}
														onClick={() => moveTrack(track, -1)}
														size="sm"
														title="Move track down"
														variant="ghost"
													>
														↓
													</Button>
													<Button
														aria-label={`Move ${setting.name} up`}
														disabled={index === order.length - 1}
														onClick={() => moveTrack(track, 1)}
														size="sm"
														title="Move track up"
														variant="ghost"
													>
														↑
													</Button>
													<Button
														aria-label={`${setting.muted ? "Unmute" : "Mute"} ${setting.name}`}
														aria-pressed={setting.muted}
														onClick={() =>
															setTrackSetting(track, {
																muted: !setting.muted,
															})
														}
														size="sm"
														title={
															setting.muted ? "Unmute track" : "Mute track"
														}
														variant={setting.muted ? "default" : "ghost"}
													>
														M
													</Button>
													<Button
														aria-label={`${setting.solo ? "Unsolo" : "Solo"} ${setting.name}`}
														aria-pressed={setting.solo}
														onClick={() =>
															setTrackSetting(track, {
																solo: !setting.solo,
															})
														}
														size="sm"
														title={setting.solo ? "Unsolo track" : "Solo track"}
														variant={setting.solo ? "default" : "ghost"}
													>
														S
													</Button>
													<Button
														aria-label={`${setting.locked ? "Unlock" : "Lock"} ${setting.name}`}
														aria-pressed={setting.locked}
														onClick={() =>
															setTrackSetting(track, {
																locked: !setting.locked,
															})
														}
														size="sm"
														title={
															setting.locked ? "Unlock track" : "Lock track"
														}
														variant={setting.locked ? "default" : "ghost"}
													>
														{setting.locked ? "L" : "🔒"}
													</Button>
												</div>
											</div>
											{project.segments
												.filter((s) => s.track === track)
												.map((s) => (
													<TimelineClip
														assetDuration={
															assets.find((asset) => asset.id === s.assetId)
																?.duration ?? segmentDuration(s)
														}
														fps={project.fps}
														key={s.id}
														locked={setting.locked}
														markers={project.markers}
														name={
															assets.find((a) => a.id === s.assetId)?.name ??
															"Media"
														}
														onMove={(start, track) => {
															if (trackSettingFor(project, track).locked) {
																setStatus(
																	"Unlock the destination track before moving a clip there."
																);
																return;
															}
															edit({
																...project,
																segments: project.segments.map((segment) =>
																	segment.id === s.id
																		? { ...segment, start, track }
																		: segment
																),
															});
															setSelected(s.id);
															setTime(start);
														}}
														onSelect={(additive) => {
															const next = additive
																? selectedIds.includes(s.id)
																	? selectedIds.filter((id) => id !== s.id)
																	: [...selectedIds, s.id]
																: [s.id];
															setSelectedIds(next);
															setSelected(next.at(-1) ?? null);
															setTime(s.start);
														}}
														onTrim={(next) => {
															edit({
																...project,
																segments: project.segments.map((segment) =>
																	segment.id === s.id ? next : segment
																),
															});
															setSelected(s.id);
															setTime(next.start);
														}}
														segment={s}
														selected={selectedIds.includes(s.id)}
														zoom={zoom}
													/>
												))}
										</div>
									);
								})}
								<div
									aria-hidden="true"
									className="studio-playhead"
									style={{ left: time * zoom }}
								/>
							</div>
						</div>
					</section>
				</>
			) : (
				<RyuAppMain>
					<RyuAppEmpty
						description="Import your footage, build a timeline, and shape each scene. Your projects and exports stay on your Ryu node."
						title="A place for your next film"
					/>
				</RyuAppMain>
			)}
			<input
				accept="video/*,audio/*,image/png,image/jpeg,image/webp"
				hidden
				multiple
				onChange={(e) => {
					void importFiles(e.target.files);
					e.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
			<input
				accept=".srt,.vtt"
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file && project) {
						void act(async () => {
							if (file.size > 2_000_000) {
								throw new Error("Subtitle file is too large.");
							}
							editCaptions(parseSubtitles(await file.text()));
						});
					}
					e.target.value = "";
				}}
				ref={captionPicker}
				type="file"
			/>
		</div>
	);
}
