import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { type KeyboardEvent, useMemo, useState } from "react";
import { bindingLabel, groupShortcuts } from "./catalog.ts";
import {
	type ComboClash,
	clashesForCombo,
	findShortcutConflicts,
	reservedChordFor,
} from "./conflicts.ts";
import type { ActionId, KeyCombo, ShortcutBinding } from "./defaults.ts";
import {
	comboId,
	comboLabel,
	detectKeyPlatform,
	type KeyPlatform,
	recordKeyEvent,
} from "./keys.ts";
import {
	isBindingCustomized,
	NO_OVERRIDES,
	type RecordMode,
	withBindingKeys,
	withBindingReset,
	withRecordedCombo,
} from "./persistence.ts";
import { hasActionHandler } from "./registry.ts";
import {
	conflictNotes,
	describeClashOutcome,
} from "./ShortcutsDialog-conflict-notes.ts";
import { ShortcutRowItem } from "./ShortcutsDialog-row-item.tsx";
import { ShortcutsReference } from "./ShortcutsReference.tsx";
import {
	type ShortcutStore,
	shortcutStore,
	useShortcutState,
} from "./shortcut-state.ts";

export { describeClashOutcome } from "./ShortcutsDialog-conflict-notes.ts";

interface Recording {
	bindingId: string;
	mode: RecordMode;
}

interface PendingClash extends Recording {
	clashes: ComboClash[];
	combo: KeyCombo;
}

interface ShortcutsDialogProps {
	/** Which actions to list (default: those with a handler). */
	isAvailable?: (action: ActionId) => boolean;
	onClose: () => void;
	open: boolean;
	platform?: KeyPlatform;
	store?: ShortcutStore;
}

/**
 * Keyboard shortcut dialog (`?`). Lists actions by category with search,
 * records new chords, prompts before taking a chord another action uses,
 * resets one binding or all of them, and opens a printable reference sheet.
 * Changes persist per viewer and apply immediately.
 */
export function ShortcutsDialog({
	isAvailable = hasActionHandler,
	onClose,
	open,
	platform: platformProp,
	store = shortcutStore,
}: ShortcutsDialogProps) {
	const tl = useLiteralMessages();
	const bindings = useShortcutState((state) => state.bindings, store);
	const overrides = useShortcutState((state) => state.overrides, store);
	const persisted = useShortcutState((state) => state.persisted, store);
	const [platform] = useState(() => platformProp ?? detectKeyPlatform());
	const [query, setQuery] = useState("");
	const [view, setView] = useState<"list" | "reference">("list");
	const [recording, setRecording] = useState<Recording | null>(null);
	const [pending, setPending] = useState<PendingClash | null>(null);
	const [notice, setNotice] = useState("");
	const [confirmResetAll, setConfirmResetAll] = useState(false);

	const available = useMemo(
		() => bindings.filter((binding) => isAvailable(binding.action)),
		[bindings, isAvailable]
	);
	const groups = useMemo(
		() => groupShortcuts(available, { platform, query }),
		[available, platform, query]
	);
	const notes = useMemo(
		() => conflictNotes(findShortcutConflicts(available), bindings, platform),
		[available, bindings, platform]
	);
	const customizedCount = Object.keys(overrides).length;

	const commit = (next: typeof overrides, message: string) => {
		const saved = store.setOverrides(next);
		setNotice(
			saved
				? message
				: tl(
						"{message} This browser isn't keeping preferences, so it lasts until you reload.",
						{ message }
					)
		);
	};

	const finishRecording = (
		target: Recording,
		combo: KeyCombo,
		clashes: ComboClash[]
	) => {
		commit(
			withRecordedCombo(
				overrides,
				bindings,
				target.bindingId,
				combo,
				target.mode,
				clashes
			),
			`${bindingLabel(bindings, target.bindingId)} is now ${comboLabel(combo, platform)}.`
		);
		setPending(null);
	};

	const onRecordKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (!recording) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const outcome = recordKeyEvent(event);
		if (outcome.kind === "ignore") {
			return;
		}
		const target = recording;
		setRecording(null);
		if (outcome.kind === "cancel") {
			setNotice("Recording canceled.");
			return;
		}
		if (outcome.kind === "invalid") {
			setNotice(outcome.reason);
			return;
		}
		const reserved = reservedChordFor(outcome.combo);
		if (reserved) {
			setNotice(
				tl(
					"{chord} is the system-wide {label} shortcut, so it never reaches Video Studio. Choose another key.",
					{ chord: comboLabel(outcome.combo, platform), label: reserved.label }
				)
			);
			return;
		}
		const clashes = clashesForCombo(available, target.bindingId, outcome.combo);
		if (clashes.length > 0) {
			setPending({ ...target, clashes, combo: outcome.combo });
			setNotice("");
			return;
		}
		finishRecording(target, outcome.combo, []);
	};

	const startRecording = (bindingId: string, mode: RecordMode) => {
		setPending(null);
		setConfirmResetAll(false);
		setNotice("");
		setRecording({ bindingId, mode });
	};

	const removeCombo = (binding: ShortcutBinding, combo: KeyCombo) => {
		const removed = comboId(combo);
		commit(
			withBindingKeys(
				overrides,
				binding.id,
				binding.keys.filter((key) => comboId(key) !== removed)
			),
			`Removed ${comboLabel(combo, platform)} from ${bindingLabel(bindings, binding.id)}.`
		);
	};

	const close = () => {
		setRecording(null);
		setPending(null);
		setConfirmResetAll(false);
		setView("list");
		onClose();
	};

	return (
		<Dialog
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				if (recording) {
					// Escape while recording cancels the recording, not the dialog.
					setRecording(null);
					setNotice("Recording canceled.");
					return;
				}
				close();
			}}
			open={open}
		>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						Change any shortcut by recording a new key. Changes are kept for you
						in this browser.
					</DialogDescription>
				</DialogHeader>
				{view === "reference" ? (
					<div className="max-h-[60vh] overflow-y-auto">
						<ShortcutsReference
							bindings={bindings}
							isAvailable={isAvailable}
							onBack={() => setView("list")}
							platform={platform}
						/>
					</div>
				) : (
					<div className="flex min-w-0 flex-col gap-3">
						<Input
							aria-label="Search shortcuts"
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search actions or keys"
							type="search"
							value={query}
						/>
						{pending && (
							<div
								className="flex flex-col gap-2 rounded-md border border-destructive px-3 py-2"
								role="alert"
							>
								<p>
									{tl(
										"{chord} is already used by {others}. Reassign it to {target}?",
										{
											chord: comboLabel(pending.combo, platform),
											others: [
												...new Set(
													pending.clashes.map((clash) =>
														bindingLabel(bindings, clash.otherId)
													)
												),
											].join(", "),
											target: bindingLabel(bindings, pending.bindingId),
										}
									)}
								</p>
								<ul className="list-disc pl-5">
									{pending.clashes.map((clash) => (
										<li key={`${clash.otherId}:${comboId(clash.combo)}`}>
											{describeClashOutcome(
												bindingLabel(bindings, clash.otherId),
												clash.combo,
												pending.combo,
												platform
											)}
										</li>
									))}
								</ul>
								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() =>
											finishRecording(pending, pending.combo, pending.clashes)
										}
									>
										Reassign
									</Button>
									<Button
										onClick={() => {
											setPending(null);
											setNotice("Kept the existing shortcuts.");
										}}
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							</div>
						)}
						<div
							aria-label="Shortcuts by category"
							className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto"
							role="region"
						>
							{groups.length === 0 && (
								<p className="text-muted-foreground">
									{tl("No shortcuts match “{query}”.", { query })}
								</p>
							)}
							{groups.map((group) => (
								<section aria-label={group.category} key={group.category}>
									<h3 className="mb-1 font-medium text-muted-foreground text-sm">
										{group.category}
									</h3>
									<ul className="flex flex-col">
										{group.rows.map(({ binding, label }) => (
											<ShortcutRowItem
												binding={binding}
												customized={isBindingCustomized(overrides, binding.id)}
												key={binding.id}
												label={label}
												notes={notes.get(binding.id) ?? []}
												onRecordKey={onRecordKey}
												onRemove={(combo) => removeCombo(binding, combo)}
												onReset={() =>
													commit(
														withBindingReset(overrides, binding.id),
														`${label} is back to its default.`
													)
												}
												onStartRecording={(mode) =>
													startRecording(binding.id, mode)
												}
												onStopRecording={() => setRecording(null)}
												platform={platform}
												recording={
													recording?.bindingId === binding.id
														? recording.mode
														: null
												}
											/>
										))}
									</ul>
								</section>
							))}
						</div>
					</div>
				)}
				<p
					aria-live="polite"
					className="min-h-5 text-muted-foreground"
					role="status"
				>
					{notice ||
						(persisted
							? ""
							: "This browser isn't keeping preferences; changes last until you reload.")}
				</p>
				<DialogFooter>
					{confirmResetAll ? (
						<>
							<span className="self-center">Reset every shortcut?</span>
							<Button
								onClick={() => {
									setConfirmResetAll(false);
									commit(
										NO_OVERRIDES,
										"Every shortcut is back to its default."
									);
								}}
								variant="destructive"
							>
								Reset all
							</Button>
							<Button onClick={() => setConfirmResetAll(false)} variant="ghost">
								Keep
							</Button>
						</>
					) : (
						<Button
							disabled={customizedCount === 0}
							onClick={() => setConfirmResetAll(true)}
							variant="ghost"
						>
							Reset all
						</Button>
					)}
					{view === "list" && (
						<Button onClick={() => setView("reference")} variant="outline">
							Printable reference
						</Button>
					)}
					<Button onClick={close}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The dialog wired to the shortcut store: `?` opens it, closing updates the store. */
export function ConnectedShortcutsDialog({
	store = shortcutStore,
}: {
	store?: ShortcutStore;
}) {
	const open = useShortcutState((state) => state.dialogOpen, store);
	return (
		<ShortcutsDialog
			onClose={() => store.closeDialog()}
			open={open}
			store={store}
		/>
	);
}
