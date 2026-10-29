import { Badge, Button, Input } from "@ryu/blocks/companion/controls";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { bindingLabel, groupShortcuts } from "./catalog.ts";
import {
	type ComboClash,
	clashesForCombo,
	findShortcutConflicts,
	reservedChordFor,
	type ShortcutConflict,
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
	narrowedClashCombo,
	type RecordMode,
	withBindingKeys,
	withBindingReset,
	withRecordedCombo,
} from "./persistence.ts";
import { hasActionHandler } from "./registry.ts";
import { ShortcutsReference } from "./ShortcutsReference.tsx";
import {
	type ShortcutStore,
	shortcutStore,
	useShortcutState,
} from "./shortcut-state.ts";

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

/** What a reassign does to one clashing chord, naming the exact chord kept or lost. */
export function describeClashOutcome(
	otherLabel: string,
	existing: KeyCombo,
	taken: KeyCombo,
	platform: KeyPlatform
): string {
	const kept = narrowedClashCombo(existing, taken);
	if (kept) {
		return `${otherLabel} keeps ${comboLabel(kept, platform)}.`;
	}
	return `${otherLabel} loses ${comboLabel(existing, platform)}.`;
}

/** Conflict notes keyed by binding id, worded from that binding's side. */
function conflictNotes(
	conflicts: readonly ShortcutConflict[],
	bindings: readonly ShortcutBinding[],
	platform: KeyPlatform
): Map<string, string[]> {
	const notes = new Map<string, string[]>();
	const add = (id: string, note: string) =>
		notes.set(id, [...(notes.get(id) ?? []), note]);
	for (const { bindingIds, combo } of conflicts) {
		const [winner, loser] = bindingIds;
		if (!(winner && loser)) {
			continue;
		}
		const chord = comboLabel(combo, platform);
		add(
			loser,
			`${chord} runs ${bindingLabel(bindings, winner)} instead of this.`
		);
		add(winner, `Also takes ${chord} from ${bindingLabel(bindings, loser)}.`);
	}
	return notes;
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
				: `${message} This browser isn't keeping preferences, so it lasts until you reload.`
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
				`${comboLabel(outcome.combo, platform)} is the system-wide ${reserved.label} shortcut, so it never reaches Video Studio. Choose another key.`
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
									{comboLabel(pending.combo, platform)} is already used by{" "}
									{[
										...new Set(
											pending.clashes.map((clash) =>
												bindingLabel(bindings, clash.otherId)
											)
										),
									].join(", ")}
									. Reassign it to {bindingLabel(bindings, pending.bindingId)}?
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
									No shortcuts match “{query}”.
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

function ShortcutRowItem({
	binding,
	customized,
	label,
	notes,
	onRecordKey,
	onRemove,
	onReset,
	onStartRecording,
	onStopRecording,
	platform,
	recording,
}: {
	binding: ShortcutBinding;
	customized: boolean;
	label: string;
	notes: readonly string[];
	onRecordKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
	onRemove: (combo: KeyCombo) => void;
	onReset: () => void;
	onStartRecording: (mode: RecordMode) => void;
	onStopRecording: () => void;
	platform: KeyPlatform;
	recording: RecordMode | null;
}) {
	const recorder = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (recording) {
			recorder.current?.focus();
		}
	}, [recording]);
	return (
		<li
			className="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0"
			data-binding-id={binding.id}
		>
			<span className="min-w-0 flex-1 basis-40">
				{label}
				{customized && (
					<Badge className="ms-2" variant="secondary">
						Custom
					</Badge>
				)}
			</span>
			<span className="flex flex-wrap items-center gap-1">
				{binding.keys.length === 0 && (
					<span className="text-muted-foreground">No shortcut</span>
				)}
				{binding.keys.map((combo) => {
					const chord = comboLabel(combo, platform);
					return (
						<span
							className="inline-flex items-center gap-1 rounded border px-1.5 font-mono text-xs"
							key={comboId(combo)}
						>
							<kbd>{chord}</kbd>
							<button
								aria-label={`Remove ${chord} from ${label}`}
								className="text-muted-foreground hover:text-foreground"
								onClick={() => onRemove(combo)}
								type="button"
							>
								×
							</button>
						</span>
					);
				})}
			</span>
			<span className="flex flex-wrap gap-1">
				{recording ? (
					<Button
						aria-label={`Press the new shortcut for ${label}, or Escape to cancel`}
						onBlur={onStopRecording}
						onKeyDown={onRecordKey}
						ref={recorder}
						variant="outline"
					>
						Press keys…
					</Button>
				) : (
					<>
						<Button
							aria-label={`Change shortcut for ${label}`}
							onClick={() => onStartRecording("replace")}
							variant="ghost"
						>
							Change
						</Button>
						<Button
							aria-label={`Add another shortcut for ${label}`}
							onClick={() => onStartRecording("add")}
							variant="ghost"
						>
							Add
						</Button>
					</>
				)}
				{customized && (
					<Button
						aria-label={`Reset ${label} to its default`}
						onClick={onReset}
						variant="ghost"
					>
						Reset
					</Button>
				)}
			</span>
			{notes.length > 0 && (
				<span className="basis-full text-destructive text-xs">
					{notes.join(" ")}
				</span>
			)}
		</li>
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
