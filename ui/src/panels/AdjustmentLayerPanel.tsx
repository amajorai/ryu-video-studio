import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	type AdjustmentLayer,
	type AdjustmentLayerPatch,
	adjustmentPreviewApproximate,
	DEFAULT_ADJUSTMENT_DURATION,
	MAX_ADJUSTMENT_LAYERS,
	neutralAdjustmentPatch,
	orderedAdjustmentLayers,
} from "../../../shared/adjustment.ts";
import { timelineClock } from "../editing-ui.ts";
import { useEditor } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore } from "../editor/store.ts";
import { LayerEditor, MAX_TIME } from "./AdjustmentLayerPanel-layer-editor.tsx";
import type { PanelTab } from "./types.ts";

/** Adjustment layers have their own library tab. */
export const adjustmentLayerPanelTab: PanelTab | null = {
	label: "Adjustments",
	value: "adjustments",
};

const ADJUSTMENT_ROUTE = "adjustment-layers";

function selectLayer(runtime: EditorRuntime, id: string | null) {
	runtime.store.setState((state) => ({
		selection: {
			...state.selection,
			overlayIds: id ? [{ id, kind: "adjustmentLayers" }] : [],
		},
	}));
}

function layerSummary(layer: AdjustmentLayer): string {
	return `${timelineClock(layer.start)}–${timelineClock(layer.end)} · tracks 1–${layer.track + 1}`;
}

/**
 * Adjustment layers: a timed grade, effect stack and masks over every clip
 * on the chosen track and below. Every edit is a revisioned
 * `POST /projects/:id/adjustment-layers`, so the agent has the same API.
 */
export function AdjustmentLayerPanel() {
	const runtime = useEditor();
	const overlayIds = useEditorStore(
		runtime.store,
		(state) => state.selection.overlayIds
	);
	const { busy, project, time } = runtime;
	if (!project) {
		return null;
	}
	const layers = orderedAdjustmentLayers(project.adjustmentLayers);
	const selectedId =
		overlayIds.find((overlay) => overlay.kind === "adjustmentLayers")?.id ??
		layers[0]?.id;
	const selected = layers.find((layer) => layer.id === selectedId);
	const edit = async (body: Record<string, unknown>, message: string) => {
		const outcome = await runtime.routeEdit(
			ADJUSTMENT_ROUTE,
			body,
			() => message
		);
		const created = outcome.status === "ok" ? outcome.extras?.layer : undefined;
		if (
			created &&
			typeof created === "object" &&
			"id" in created &&
			typeof created.id === "string"
		) {
			selectLayer(runtime, created.id);
		}
		return outcome;
	};
	const create = () => {
		const start = Math.min(time, MAX_TIME - 0.1);
		void edit(
			{
				action: "create",
				layer: {
					end: Math.min(MAX_TIME, start + DEFAULT_ADJUSTMENT_DURATION),
					start,
				},
			},
			"Added an adjustment layer at the playhead."
		);
	};
	const update = (patch: AdjustmentLayerPatch, message: string) => {
		if (selected) {
			void runtime.routeEdit(
				ADJUSTMENT_ROUTE,
				{ action: "update", layer: patch, layerId: selected.id },
				() => message
			);
		}
	};
	return (
		<RyuAppField
			description="Grade and effects over every clip on the chosen track and below, for a time range."
			label="Adjustment layers"
		>
			<RyuAppActions>
				<Button
					disabled={busy || layers.length >= MAX_ADJUSTMENT_LAYERS}
					onClick={create}
					size="sm"
				>
					Add adjustment layer
				</Button>
			</RyuAppActions>
			{layers.length === 0 ? (
				<small>
					No adjustment layers yet. Add one at the playhead to grade everything
					below it.
				</small>
			) : (
				<ul className="flex flex-col gap-1" data-testid="adjustment-layers">
					{layers.map((layer) => (
						<li key={layer.id}>
							<button
								aria-pressed={layer.id === selected?.id}
								className="flex w-full flex-col items-start rounded-md border px-2 py-1 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
								onClick={() => selectLayer(runtime, layer.id)}
								type="button"
							>
								<span className="font-medium">{layer.label}</span>
								<span className="text-muted-foreground">
									{layerSummary(layer)}
									{adjustmentPreviewApproximate(layer)
										? " · approximate preview while playing"
										: ""}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{selected ? (
				<>
					<LayerEditor
						disabled={busy}
						key={selected.id}
						layer={selected}
						update={update}
					/>
					<RyuAppActions>
						<Button
							disabled={busy}
							onClick={() =>
								update(neutralAdjustmentPatch, "Reset the adjustment layer.")
							}
							size="sm"
							variant="outline"
						>
							Reset grade
						</Button>
						<Button
							disabled={busy || layers.length >= MAX_ADJUSTMENT_LAYERS}
							onClick={() =>
								void edit(
									{ action: "duplicate", layerId: selected.id },
									"Duplicated the adjustment layer after itself."
								)
							}
							size="sm"
							variant="outline"
						>
							Duplicate
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								selectLayer(runtime, null);
								void runtime.routeEdit(
									ADJUSTMENT_ROUTE,
									{ action: "delete", layerId: selected.id },
									() => "Deleted the adjustment layer."
								);
							}}
							size="sm"
							variant="destructive"
						>
							Delete
						</Button>
					</RyuAppActions>
				</>
			) : null}
		</RyuAppField>
	);
}
