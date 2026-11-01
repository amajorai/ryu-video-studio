import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	cutoutMaxSeconds,
	DEFAULT_KEY_COLOR,
	type Key,
	type KeyFilterAvailability,
	type KeyType,
	keyCapabilityIssues,
	keyTypeAvailable,
	keyTypeLabels,
	keyTypes,
	newKey,
	resolvedKeyOf,
	sourceTimeUnderPlayhead,
	spillChannelOf,
} from "../../../../shared/keying.ts";
import { type Asset, assetSchema } from "../../../../shared/project.ts";
import { loadAssets } from "../../bridge.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { NumberField } from "../../NumberField.tsx";
import {
	armEyedropper,
	EYEDROPPER_TOGGLE_ATTRIBUTE,
} from "../../preview/eyedropper.ts";
import type { ClipSectionProps } from "../section-props.ts";

const capabilitiesSchema = z.object({
	encoders: z.record(z.string(), z.boolean()),
	filters: z.record(z.string(), z.boolean()),
});
type Capabilities = z.infer<typeof capabilitiesSchema>;

const inspectFrameSchema = z.object({
	data: z.string(),
	height: z.number(),
	width: z.number(),
});

const isKeyType = (value: string): value is KeyType =>
	(keyTypes as readonly string[]).includes(value);

/** FFmpeg filters and encoders from `GET /capabilities` (null until read or when unreadable). */
function useCapabilities(
	api: (path: string) => Promise<unknown>
): Capabilities | null {
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const read = useRef(api);
	useEffect(() => {
		let mounted = true;
		read
			.current("/capabilities")
			.then((value) => {
				const parsed = capabilitiesSchema.safeParse(value);
				if (mounted && parsed.success) {
					setCapabilities(parsed.data);
				}
			})
			.catch(() => undefined);
		return () => {
			mounted = false;
		};
	}, []);
	return capabilities;
}

/** Why the cutout cannot run for this media on this FFmpeg build, or null when it can. */
function cutoutUnavailable(
	asset: Asset,
	capabilities: Capabilities | null
): string | null {
	const maxSeconds = cutoutMaxSeconds(asset);
	if (asset.duration > maxSeconds) {
		return `Background cutout supports ${asset.width}×${asset.height} media up to ${maxSeconds} s long; trim or split the clip first.`;
	}
	if (!capabilities) {
		return null;
	}
	if (capabilities.filters.backgroundkey === false) {
		return "This FFmpeg build has no backgroundkey filter.";
	}
	if (capabilities.encoders.prores_ks === false) {
		return "This FFmpeg build has no prores_ks encoder, which the transparent ProRes 4444 cutout needs.";
	}
	return null;
}

function CutoutControls({
	asset,
	capabilities,
	segmentId,
}: {
	asset: Asset;
	capabilities: Capabilities | null;
	segmentId: string;
}) {
	const runtime = useEditorProject();
	const segment = runtime.project.segments.find(
		(item) => item.id === segmentId
	);
	const [plate, setPlate] = useState(() =>
		segment ? sourceTimeUnderPlayhead(segment, runtime.time) : 0
	);
	const [threshold, setThreshold] = useState(0.5);
	if (!segment) {
		return null;
	}
	if (asset.derivation === "cutout") {
		return (
			<RyuAppField label="Background cutout">
				<small>This clip already plays a background cutout.</small>
			</RyuAppField>
		);
	}
	const unavailable = cutoutUnavailable(asset, capabilities);
	const create = async () => {
		await runtime.act(async () => {
			runtime.setStatus("Cutting out the static background…");
			const created = assetSchema.parse(
				await runtime.api(`/assets/${asset.id}/cutout`, {
					cleanPlateTime: Math.min(plate, Math.max(0, asset.duration - 0.001)),
					threshold,
				})
			);
			runtime.setAssets(await loadAssets());
			runtime.setStatus(`Created ${created.name}.`);
			await runtime.routeEdit(
				"swap-clip-media",
				{ assetId: created.id, clipId: segment.id },
				() => "Swapped the clip to its background cutout."
			);
		});
	};
	return (
		<RyuAppField
			description={
				unavailable ??
				"For a locked-off camera: pick a frame of the empty shot as the clean plate. Everything that matches it becomes transparent."
			}
			label="Background cutout"
		>
			<div className="studio-inline-fields">
				<NumberField
					label="Clean plate (source s)"
					max={Math.max(0, asset.duration)}
					min={0}
					onChange={setPlate}
					step={0.1}
					value={plate}
				/>
				<NumberField
					label="Scene threshold"
					max={1}
					min={0}
					onChange={setThreshold}
					step={0.05}
					value={threshold}
				/>
			</div>
			<RyuAppActions>
				<Button
					onClick={() =>
						setPlate(sourceTimeUnderPlayhead(segment, runtime.time))
					}
					size="sm"
					variant="outline"
				>
					Use playhead frame
				</Button>
				<Button
					disabled={runtime.busy || unavailable !== null}
					onClick={() => void create()}
					size="sm"
					variant="outline"
				>
					Swap clip to cutout
				</Button>
			</RyuAppActions>
		</RyuAppField>
	);
}

function KeyColorField({
	asset,
	keyValue,
	onChange,
}: {
	asset: Asset | undefined;
	keyValue: Key;
	onChange: (key: Key) => void;
}) {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const [picking, setPicking] = useState(false);
	const disarm = useRef<(() => void) | null>(null);
	useEffect(() => () => disarm.current?.(), []);
	const color = keyValue.color ?? DEFAULT_KEY_COLOR;
	const latest = useRef({ keyValue, onChange });
	useEffect(() => {
		latest.current = { keyValue, onChange };
	});
	const togglePicking = () => {
		if (picking) {
			disarm.current?.();
			disarm.current = null;
			setPicking(false);
			return;
		}
		const { project, time } = runtime;
		setPicking(true);
		runtime.setStatus("Click the clip in the preview to pick the key color.");
		disarm.current = armEyedropper({
			inspectFrame: async () =>
				inspectFrameSchema.parse(
					await runtime.api(
						`/projects/${project.id}/inspect-frame?time=${time.toFixed(3)}`
					)
				),
			label: asset?.name,
			onCancel: () => {
				disarm.current = null;
				setPicking(false);
			},
			onError: (error) => {
				disarm.current = null;
				setPicking(false);
				runtime.setStatus(error);
			},
			onPick: (hex) => {
				disarm.current = null;
				setPicking(false);
				latest.current.onChange({ ...latest.current.keyValue, color: hex });
				runtime.setStatus(tl("Key color set to {hex}.", { hex }));
			},
		});
	};
	return (
		<RyuAppField label="Key color">
			<ColorPickerPopover
				onValueChange={(value) => onChange({ ...keyValue, color: value })}
				triggerAriaLabel="Key color"
				triggerClassName="w-full justify-start"
				value={color}
			/>
			<Button
				aria-pressed={picking}
				{...{ [EYEDROPPER_TOGGLE_ATTRIBUTE]: "" }}
				onClick={togglePicking}
				size="sm"
				variant="outline"
			>
				{picking ? "Cancel picking" : "Pick from preview"}
			</Button>
		</RyuAppField>
	);
}

/** Similarity/blend/spill or luma band controls for the active key. */
function KeyTuning({
	capabilities,
	keyValue,
	onChange,
}: {
	capabilities: KeyFilterAvailability;
	keyValue: Key;
	onChange: (key: Key) => void;
}) {
	const tl = useLiteralMessages();
	const resolved = resolvedKeyOf(keyValue);
	const spillChannel = spillChannelOf(keyValue);
	const despillMissing = capabilities.despill === false;
	return (
		<div className="studio-inline-fields">
			{keyValue.type === "luma" ? (
				<>
					<NumberField
						label="Luma low"
						max={resolved.lumaHigh}
						min={0}
						onChange={(value) => onChange({ ...keyValue, lumaLow: value })}
						step={0.01}
						value={resolved.lumaLow}
					/>
					<NumberField
						label="Luma high"
						max={1}
						min={resolved.lumaLow}
						onChange={(value) => onChange({ ...keyValue, lumaHigh: value })}
						step={0.01}
						value={resolved.lumaHigh}
					/>
				</>
			) : (
				<NumberField
					label="Similarity"
					max={1}
					min={0.01}
					onChange={(value) => {
						const { hueRange: _hueRange, ...rest } = keyValue;
						onChange({ ...rest, similarity: value });
					}}
					step={0.01}
					value={resolved.similarity}
				/>
			)}
			<NumberField
				label={keyValue.type === "luma" ? "Softness" : "Edge blend"}
				max={1}
				min={0}
				onChange={(value) => onChange({ ...keyValue, blend: value })}
				step={0.01}
				value={resolved.blend}
			/>
			{spillChannel && !despillMissing && (
				<NumberField
					label={
						spillChannel === "green" ? tl("Green spill") : tl("Blue spill")
					}
					max={1}
					min={0}
					onChange={(value) => onChange({ ...keyValue, spill: value })}
					step={0.05}
					value={resolved.spill}
				/>
			)}
		</div>
	);
}

/**
 * Chroma, RGB color, hue and luma keying with spill suppression, an
 * eyedropper, and the static-background cutout derivative (W2-V4). Choosing
 * Off clears `key`. Agents set the same field through `clip-properties`.
 */
export function KeySection({
	isAudio,
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	const runtime = useEditorProject();
	const capabilities = useCapabilities(runtime.api);
	const tl = useLiteralMessages();
	if (!visualControls || isAudio) {
		return null;
	}
	const asset = runtime.assets.find((item) => item.id === segment.assetId);
	const filters: KeyFilterAvailability = capabilities?.filters ?? {};
	const { key } = segment;
	const issues = keyCapabilityIssues(key, filters);
	const setKey = (next: Key | undefined) => onChange({ key: next });
	return (
		<>
			<RyuAppField
				description={issues.length > 0 ? issues.join(" ") : undefined}
				label="Key"
			>
				<NativeSelect
					aria-label="Key type"
					onChange={(event) => {
						const { value } = event.target;
						if (value === "off") {
							setKey(undefined);
						} else if (isKeyType(value)) {
							setKey(newKey(value, key));
						}
					}}
					value={key?.type ?? "off"}
				>
					<NativeSelectOption value="off">Off</NativeSelectOption>
					{keyTypes.map((type) => (
						<NativeSelectOption
							disabled={!keyTypeAvailable(type, filters) && key?.type !== type}
							key={type}
							value={type}
						>
							{keyTypeAvailable(type, filters)
								? keyTypeLabels[type]
								: tl("{keyType} (unavailable in this FFmpeg)", {
										keyType: keyTypeLabels[type],
									})}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{key && key.type !== "luma" && (
				<KeyColorField
					asset={asset}
					// Per clip: a new selection drops a pending eyedropper.
					key={`color-${segment.id}`}
					keyValue={key}
					onChange={setKey}
				/>
			)}
			{key && (
				<KeyTuning capabilities={filters} keyValue={key} onChange={setKey} />
			)}
			{asset?.kind === "video" && (
				<CutoutControls
					asset={asset}
					capabilities={capabilities}
					// Per clip: the clean plate and threshold never carry over.
					key={`cutout-${segment.id}`}
					segmentId={segment.id}
				/>
			)}
		</>
	);
}
