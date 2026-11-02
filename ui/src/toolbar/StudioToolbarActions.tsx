import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/blocks/companion/controls";
import {
	AutosaveIndicator,
	useAutosaveState,
} from "../editor/AutosaveIndicator.tsx";
import { exportVideo, hasRenderableContent } from "../editor/actions/export.ts";
import { useEditor } from "../editor/context.tsx";
import {
	captureFrame,
	createProject,
	duplicateProject,
} from "../editor/project-actions.ts";
import { useActionKeyHint, withKeyHint } from "../shortcuts/action-keys.ts";
import { runAction } from "../shortcuts/registry.ts";

interface SecondaryAction {
	disabled: boolean;
	keys?: string;
	label: string;
	run: () => void;
	title?: string;
}

/**
 * The app toolbar's actions. The autosave chip reports save state, so the
 * Save button appears only while edits are pending (Cmd/Ctrl+S saves at any
 * time). New project, Duplicate, Capture frame and Ask agent sit inline on
 * wide layouts and move into a "More actions" menu at phone width.
 */
export function StudioToolbarActions({ ready }: { ready: boolean }) {
	const runtime = useEditor();
	const { busy, dirty, duration, project } = runtime;
	const autosave = useAutosaveState();
	const saveKeys = useActionKeyHint("project.save");
	const askKeys = useActionKeyHint("ai.askAgent");
	const showSave = Boolean(project) && dirty && autosave?.status !== "conflict";
	const secondary: SecondaryAction[] = [
		{
			disabled: !ready || busy,
			label: "New project",
			run: () => void createProject(runtime),
		},
		{
			disabled: !project || busy,
			label: "Duplicate project",
			run: () => void duplicateProject(runtime),
		},
		{
			disabled: !(project && duration) || busy,
			label: "Capture frame",
			run: () => void captureFrame(runtime),
		},
		{
			disabled: !project || busy,
			keys: askKeys.aria,
			label: "Ask agent",
			run: () => runAction("ai.askAgent", runtime),
			title: withKeyHint(
				"Ask agent about the selection or marked range",
				askKeys
			),
		},
	];
	return (
		<RyuAppActions className="studio-toolbar-actions">
			<span className="studio-toolbar-secondary">
				{secondary.map((action) => (
					<Button
						aria-keyshortcuts={action.keys}
						disabled={action.disabled}
						key={action.label}
						onClick={action.run}
						title={action.title}
						variant="ghost"
					>
						{action.label}
					</Button>
				))}
			</span>
			<span className="studio-toolbar-more">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label="More actions"
								title="More actions"
								variant="ghost"
							/>
						}
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						{secondary.map((action) => (
							<DropdownMenuItem
								disabled={action.disabled}
								key={action.label}
								onClick={action.run}
							>
								{action.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</span>
			<AutosaveIndicator />
			{showSave ? (
				<Button
					aria-keyshortcuts={saveKeys.aria}
					disabled={busy}
					onClick={() => runAction("project.save", runtime)}
					title={withKeyHint("Save now", saveKeys)}
					variant="outline"
				>
					Save changes
				</Button>
			) : null}
			<Button
				disabled={!hasRenderableContent(project) || busy}
				onClick={() => void exportVideo(runtime)}
			>
				Export video
			</Button>
		</RyuAppActions>
	);
}
