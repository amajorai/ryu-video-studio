import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useRef, useState } from "react";
import { hasAdvancedGrade } from "../../../../shared/color-advanced.ts";
import { colorLooks } from "../../../../shared/color-looks.ts";
import {
	CubeLutError,
	MAX_CUBE_BYTES,
	parseCubeLut,
	serializeCubeLut,
} from "../../../../shared/cube-lut.ts";
import type {
	ColorGrade,
	CurvePoint,
	LutRecord,
} from "../../../../shared/schema/color.ts";
import { ColorWheels } from "../../color/ColorWheels.tsx";
import { CurvesEditor } from "../../color/CurvesEditor.tsx";
import {
	resetAdvancedGrade,
	withGradeField,
} from "../../color/color-controls.ts";
import { HslBands } from "../../color/HslBands.tsx";
import {
	deleteLut,
	ensurePreviewLut,
	importLut,
	listLuts,
	useLutUnavailableReason,
} from "../../color/lut-client.ts";
import { useEditor } from "../../editor/context.tsx";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

type CurveTab = "master" | "red" | "green" | "blue" | "hueVsSat";

const curveTabs: { label: string; stroke: string; value: CurveTab }[] = [
	{ label: "Master", stroke: "currentColor", value: "master" },
	{ label: "Red", stroke: "#e5484d", value: "red" },
	{ label: "Green", stroke: "#30a46c", value: "green" },
	{ label: "Blue", stroke: "#3e63dd", value: "blue" },
	{ label: "Hue vs saturation", stroke: "#8e4ec6", value: "hueVsSat" },
];

const isCurveTab = (value: string): value is CurveTab =>
	curveTabs.some((tab) => tab.value === value);

const TONE_FIELDS = [
	["whites", "Whites"],
	["highlights", "Highlights"],
	["shadows", "Shadows"],
	["blacks", "Blacks"],
] as const;

function CurvesField({
	grade,
	onGrade,
}: {
	grade: ColorGrade;
	onGrade: (grade: ColorGrade) => void;
}) {
	const tl = useLiteralMessages();
	const [tab, setTab] = useState<CurveTab>("master");
	const active = curveTabs.find((item) => item.value === tab) ?? curveTabs[0];
	const points = tab === "hueVsSat" ? grade.hueVsSat : grade.curves?.[tab];
	const change = (next: CurvePoint[] | undefined) => {
		if (tab === "hueVsSat") {
			onGrade(withGradeField(grade, "hueVsSat", next));
			return;
		}
		const curves = { ...grade.curves, [tab]: next };
		const kept = Object.fromEntries(
			Object.entries(curves).filter(([, value]) => value !== undefined)
		);
		onGrade(
			withGradeField(
				grade,
				"curves",
				Object.keys(kept).length ? kept : undefined
			)
		);
	};
	return (
		<RyuAppField label="Curves">
			<NativeSelect
				aria-label="Curve channel"
				onChange={(event) => {
					const { value } = event.target;
					if (isCurveTab(value)) {
						setTab(value);
					}
				}}
				value={tab}
			>
				{curveTabs.map((item) => (
					<NativeSelectOption key={item.value} value={item.value}>
						{item.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<CurvesEditor
				label={tl("{channel} curve", {
					channel: tl(active?.label ?? "Master"),
				})}
				mode={tab === "hueVsSat" ? "hue" : "tone"}
				onChange={change}
				points={points}
				stroke={active?.stroke}
			/>
			<RyuAppActions>
				<Button
					disabled={!points}
					onClick={() => change(undefined)}
					size="sm"
					variant="outline"
				>
					Reset curve
				</Button>
			</RyuAppActions>
		</RyuAppField>
	);
}

async function readCubeFile(file: File): Promise<string> {
	if (file.size > MAX_CUBE_BYTES) {
		throw new CubeLutError(
			"The .cube file is larger than 5 MB. Export it at 33 points (or smaller) and import it again."
		);
	}
	// Validate locally and send the compact canonical form; `importLut`
	// checks it against the sidecar's request limit.
	return serializeCubeLut(parseCubeLut(await file.text()));
}

export function LutField({
	grade,
	onGrade,
}: {
	grade: ColorGrade;
	onGrade: (grade: ColorGrade) => void;
}) {
	const runtime = useEditor();
	const unavailable = useLutUnavailableReason(runtime.api);
	const tl = useLiteralMessages();
	const [luts, setLuts] = useState<LutRecord[] | null>(null);
	const [working, setWorking] = useState(false);
	const [deletable, setDeletable] = useState("");
	const fileInput = useRef<HTMLInputElement>(null);
	const latest = useRef({ runtime });
	useEffect(() => {
		latest.current = { runtime };
	});
	const lutId = grade.lut?.lutId;

	useEffect(() => {
		let mounted = true;
		listLuts()
			.then((records) => {
				if (mounted) {
					setLuts(records);
				}
			})
			.catch(() => {
				if (mounted) {
					setLuts([]);
				}
			});
		return () => {
			mounted = false;
		};
	}, []);

	useEffect(() => {
		if (!lutId) {
			return;
		}
		ensurePreviewLut(lutId)
			.then((loaded) => {
				if (loaded) {
					latest.current.runtime.setStatus("LUT loaded into the preview.");
				}
			})
			.catch(() =>
				latest.current.runtime.setStatus(
					"This clip's LUT could not be loaded for the preview."
				)
			);
	}, [lutId]);

	const select = (id: string) =>
		onGrade(
			withGradeField(
				grade,
				"lut",
				id ? { intensity: grade.lut?.intensity ?? 1, lutId: id } : undefined
			)
		);
	const importFile = async (file: File) => {
		setWorking(true);
		try {
			const record = await importLut(
				file.name.replace(/\.cube$/i, ""),
				await readCubeFile(file)
			);
			setLuts((current) => [...(current ?? []), record]);
			onGrade(withGradeField(grade, "lut", { intensity: 1, lutId: record.id }));
			runtime.setStatus(
				tl("Imported the LUT “{name}”.", { name: record.name })
			);
		} catch (error) {
			runtime.setStatus(
				error instanceof Error
					? error.message
					: "The LUT could not be imported."
			);
		} finally {
			setWorking(false);
		}
	};
	const remove = async (id: string) => {
		setWorking(true);
		try {
			await deleteLut(id);
			setLuts((current) => current?.filter((item) => item.id !== id) ?? null);
			runtime.setStatus("Deleted the LUT.");
		} catch (error) {
			runtime.setStatus(
				error instanceof Error ? error.message : "The LUT could not be deleted."
			);
		} finally {
			setWorking(false);
		}
	};
	const missing = Boolean(
		lutId && luts && !luts.some((item) => item.id === lutId)
	);

	return (
		<RyuAppField label="LUT">
			{unavailable ? <small role="note">{unavailable}</small> : null}
			<NativeSelect
				aria-label="Clip LUT"
				disabled={Boolean(unavailable) || working}
				onChange={(event) => select(event.target.value)}
				value={lutId ?? ""}
			>
				<NativeSelectOption value="">No LUT</NativeSelectOption>
				{missing && lutId ? (
					<NativeSelectOption value={lutId}>Missing LUT</NativeSelectOption>
				) : null}
				{(luts ?? []).map((record) => (
					<NativeSelectOption key={record.id} value={record.id}>
						{record.name} ({record.size}³)
					</NativeSelectOption>
				))}
			</NativeSelect>
			{missing ? (
				<small role="alert">
					This LUT is no longer in the library; exports will fail until you pick
					another one.
				</small>
			) : null}
			{grade.lut ? (
				<NumberField
					label="LUT intensity"
					max={1}
					min={0}
					onChange={(value) =>
						onGrade(
							withGradeField(grade, "lut", {
								intensity: value,
								lutId: grade.lut?.lutId ?? "",
							})
						)
					}
					step={0.05}
					value={grade.lut.intensity}
				/>
			) : null}
			<input
				accept=".cube"
				aria-label="LUT file"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) {
						void importFile(file);
					}
				}}
				ref={fileInput}
				type="file"
			/>
			<RyuAppActions>
				<Button
					disabled={Boolean(unavailable) || working}
					onClick={() => fileInput.current?.click()}
					size="sm"
					variant="outline"
				>
					Import .cube
				</Button>
			</RyuAppActions>
			{luts?.length ? (
				<div className="flex items-end gap-2">
					<NativeSelect
						aria-label="LUT to delete"
						onChange={(event) => setDeletable(event.target.value)}
						value={deletable}
					>
						<NativeSelectOption value="">Choose a LUT</NativeSelectOption>
						{luts.map((record) => (
							<NativeSelectOption key={record.id} value={record.id}>
								{record.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<Button
						disabled={!deletable || deletable === lutId || working}
						onClick={() => void remove(deletable)}
						size="sm"
						variant="outline"
					>
						Delete LUT
					</Button>
				</div>
			) : null}
		</RyuAppField>
	);
}

/** Levels, wheels, curves, HSL bands, hue-vs-sat, and LUTs. */
export function ColorAdvancedSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	const tl = useLiteralMessages();
	if (!visualControls) {
		return null;
	}
	const grade = segment.colorGrade;
	const onGrade = (colorGrade: ColorGrade) => onChange({ colorGrade });
	const look = colorLooks.find((item) => item.id === grade.look);
	return (
		<>
			<RyuAppField label="Tone">
				{look ? (
					<small data-testid="applied-look">
						{tl("Look: {name}", { name: look.name })}
					</small>
				) : null}
				<div className="studio-inline-fields">
					{TONE_FIELDS.map(([key, label]) => (
						<NumberField
							key={key}
							label={label}
							max={1}
							min={-1}
							onChange={(value) =>
								onGrade(withGradeField(grade, key, value || undefined))
							}
							step={0.05}
							value={grade[key] ?? 0}
						/>
					))}
				</div>
			</RyuAppField>
			<RyuAppField label="Color wheels">
				<ColorWheels
					gain={grade.gain}
					gamma={grade.gamma}
					lift={grade.lift}
					onChange={(name, wheel) =>
						onGrade(withGradeField(grade, name, wheel))
					}
				/>
			</RyuAppField>
			<CurvesField grade={grade} onGrade={onGrade} />
			<RyuAppField label="HSL">
				<HslBands
					bands={grade.hsl}
					onChange={(bands) => onGrade(withGradeField(grade, "hsl", bands))}
				/>
			</RyuAppField>
			<LutField grade={grade} onGrade={onGrade} />
			<RyuAppActions>
				<Button
					disabled={!(hasAdvancedGrade({ ...grade, lut: undefined }) || look)}
					onClick={() => onGrade(resetAdvancedGrade(grade))}
					size="sm"
					variant="outline"
				>
					Reset advanced grade
				</Button>
			</RyuAppActions>
		</>
	);
}
