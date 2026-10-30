import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type TouchEvent as ReactTouchEvent,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type Segment, trackSettingFor } from "../../../shared/project.ts";
import { agentHandoffAvailable } from "../editor/actions/ai.ts";
import {
	getSettingsClipboard,
	subscribeSettingsClipboard,
} from "../editor/actions/clipboard.ts";
import { useEditorProject } from "../editor/context.tsx";
import { useEditorStore } from "../editor/store.ts";
import {
	CLIP_MENU_ACTIONS,
	type ClipMenuItem,
	clipMenuModel,
	NOT_AVAILABLE,
} from "./clip-menu.ts";
import {
	menuActionAvailable,
	renameClip,
	runClipMenuItem,
} from "./clip-menu-commands.ts";
import { MAX_CLIP_LABEL_LENGTH } from "./clip-meta.ts";

const hasSettings = () => getSettingsClipboard() !== null;

function MenuEntry({
	item,
	onChoose,
}: {
	item: ClipMenuItem;
	onChoose: (item: ClipMenuItem) => void;
}) {
	const disabled = item.disabledReason !== undefined;
	const hint = item.disabledReason === NOT_AVAILABLE && (
		<ContextMenuShortcut>{NOT_AVAILABLE}</ContextMenuShortcut>
	);
	if (item.children) {
		return (
			<ContextMenuSub>
				<ContextMenuSubTrigger
					data-menu-item={item.id}
					disabled={disabled}
					title={item.disabledReason}
				>
					{item.label}
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{item.children.map((child) => (
						<MenuEntry item={child} key={child.id} onChoose={onChoose} />
					))}
				</ContextMenuSubContent>
			</ContextMenuSub>
		);
	}
	const label = (
		<>
			{item.swatch && (
				<span
					aria-hidden="true"
					className="size-3 shrink-0 rounded-full border border-border/50"
					style={{ backgroundColor: item.swatch }}
				/>
			)}
			{item.label}
			{hint}
		</>
	);
	if (item.checked !== undefined) {
		return (
			<ContextMenuCheckboxItem
				checked={item.checked}
				data-menu-item={item.id}
				disabled={disabled}
				onCheckedChange={() => onChoose(item)}
				title={item.disabledReason}
			>
				{label}
			</ContextMenuCheckboxItem>
		);
	}
	return (
		<ContextMenuItem
			data-menu-item={item.id}
			disabled={disabled}
			onClick={() => onChoose(item)}
			title={item.disabledReason}
			variant={item.destructive ? "destructive" : "default"}
		>
			{label}
		</ContextMenuItem>
	);
}

function RenameClipDialog({
	onClose,
	onRename,
	segment,
}: {
	onClose: () => void;
	onRename: (text: string) => void;
	segment: Segment;
}) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			open
		>
			<DialogContent className="sm:max-w-sm">
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						const text = new FormData(event.currentTarget).get("label");
						onRename(typeof text === "string" ? text : "");
						onClose();
					}}
				>
					<DialogHeader>
						<DialogTitle>Rename clip</DialogTitle>
						<DialogDescription>
							The label shows on the timeline clip. Leave it blank to show the
							media name.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="Clip label"
						autoFocus
						defaultValue={segment.label ?? ""}
						maxLength={MAX_CLIP_LABEL_LENGTH}
						name="label"
						placeholder="Add a label"
					/>
					<DialogFooter>
						<Button onClick={onClose} type="button" variant="outline">
							Cancel
						</Button>
						<Button type="submit">Rename</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Right-click (or long-press on touch, or Shift+F10 on a focused clip) menu
 * around a timeline clip. Opening it selects the clip, keeping an existing
 * multi-selection that contains it, and each item dispatches an editor action
 * by id or a menu command on the existing routes. Items whose action has no
 * handler yet are disabled as "Not available".
 */
export function ClipContextMenu({
	children,
	segment,
}: {
	children: ReactNode;
	segment: Segment;
}) {
	const runtime = useEditorProject();
	const latest = useRef(runtime);
	latest.current = runtime;
	const [open, setOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const pointerTime = useRef<number | undefined>(undefined);
	const clipboardReady = useEditorStore(
		runtime.store,
		(state) => state.clipboard !== null
	);
	const settingsReady = useSyncExternalStore(
		subscribeSettingsClipboard,
		hasSettings,
		hasSettings
	);
	const currentSegment = () =>
		latest.current.project?.segments.find(
			(candidate) => candidate.id === segment.id
		) ?? segment;
	const recordPointerAt = (
		target: EventTarget | null,
		clientX: number,
		clientY: number
	) => {
		const clip = (target as Element | null)?.closest?.(".studio-timeline-clip");
		const { zoom } = latest.current;
		const bounds = clip?.getBoundingClientRect();
		const inside =
			bounds !== undefined &&
			!(clientX === 0 && clientY === 0) &&
			clientX >= bounds.left &&
			clientX <= bounds.right;
		// Keyboard-opened menus (Shift+F10) carry no usable pointer position.
		pointerTime.current =
			inside && zoom > 0
				? segment.start + (clientX - bounds.left) / zoom
				: undefined;
	};
	const recordPointer = (event: ReactMouseEvent<HTMLElement>) => {
		recordPointerAt(event.target, event.clientX, event.clientY);
	};
	// A touch long-press opens the menu from its own timer without a
	// contextmenu event, so the pointer is taken from the touch that starts it.
	const recordTouch = (event: ReactTouchEvent<HTMLElement>) => {
		const touch = event.touches[0];
		if (event.touches.length === 1 && touch) {
			recordPointerAt(event.target, touch.clientX, touch.clientY);
		}
	};
	const choose = (item: ClipMenuItem) => {
		if (!item.run || item.disabledReason !== undefined) {
			return;
		}
		runClipMenuItem(item.run, {
			onRename: () => setRenaming(true),
			pointerTime: pointerTime.current,
			runtime: latest.current,
			segment: currentSegment(),
		});
	};
	const sections =
		open &&
		clipMenuModel({
			asset: runtime.assets.find(
				(candidate) => candidate.id === segment.assetId
			),
			assets: runtime.assets,
			clipboardReady,
			// "Ask agent" also needs a mounted handoff surface (W5-I2 mounts it).
			hasHandler: (action) =>
				menuActionAvailable(action) &&
				(action !== CLIP_MENU_ACTIONS.askAgent || agentHandoffAvailable()),
			locked: trackSettingFor(runtime.project, segment.track).locked,
			pointerTime: pointerTime.current,
			project: runtime.project,
			segment,
			settingsReady,
			time: runtime.time,
		});
	return (
		<>
			<ContextMenu
				onOpenChange={(next) => {
					if (next && latest.current.selectedId !== segment.id) {
						latest.current.setSelected(segment.id);
					}
					if (!next) {
						pointerTime.current = undefined;
					}
					setOpen(next);
				}}
				open={open}
			>
				<ContextMenuTrigger
					className="contents"
					data-clip-menu={segment.id}
					onContextMenu={recordPointer}
					onTouchStart={recordTouch}
				>
					{children}
				</ContextMenuTrigger>
				{sections && (
					<ContextMenuContent aria-label="Clip actions" className="max-w-72">
						{sections.map((section, index) => (
							<ContextMenuGroup key={section.id}>
								{index > 0 && <ContextMenuSeparator />}
								<ContextMenuLabel>{section.label}</ContextMenuLabel>
								{section.items.map((item) => (
									<MenuEntry item={item} key={item.id} onChoose={choose} />
								))}
							</ContextMenuGroup>
						))}
					</ContextMenuContent>
				)}
			</ContextMenu>
			{renaming && (
				<RenameClipDialog
					onClose={() => setRenaming(false)}
					onRename={(text) => {
						renameClip(latest.current, currentSegment(), text);
					}}
					segment={currentSegment()}
				/>
			)}
		</>
	);
}
