import "./ShortcutsReference.css";
import { Button } from "@ryu/blocks/companion/controls";
import { groupShortcuts } from "./catalog.ts";
import type { ActionId, ShortcutBinding } from "./defaults.ts";
import { comboLabel, type KeyPlatform } from "./keys.ts";

/**
 * A printable sheet of the viewer's effective shortcuts, grouped by
 * category. Printing hides the rest of the app (see the co-located CSS).
 */
export function ShortcutsReference({
	bindings,
	isAvailable,
	onBack,
	platform,
}: {
	bindings: readonly ShortcutBinding[];
	isAvailable?: (action: ActionId) => boolean;
	onBack?: () => void;
	platform: KeyPlatform;
}) {
	const groups = groupShortcuts(bindings, {
		isAvailable,
		platform,
		skipUnbound: true,
	});
	return (
		<div
			aria-label="Keyboard shortcut reference"
			className="studio-shortcuts-reference flex flex-col gap-4"
			role="document"
		>
			<div className="flex flex-wrap items-center gap-2" data-print-hidden="">
				{onBack && (
					<Button onClick={onBack} variant="ghost">
						Back to shortcuts
					</Button>
				)}
				<Button onClick={() => globalThis.print?.()} variant="outline">
					Print
				</Button>
			</div>
			<h2 className="font-medium text-base">Video Studio keyboard shortcuts</h2>
			<div className="grid gap-4 sm:grid-cols-2">
				{groups.map((group) => (
					<section aria-label={group.category} key={group.category}>
						<h3 className="mb-1 font-medium text-muted-foreground text-sm">
							{group.category}
						</h3>
						<table className="w-full text-sm">
							<tbody>
								{group.rows.map((row) => (
									<tr className="border-b last:border-b-0" key={row.binding.id}>
										<th className="py-1 pr-2 text-left font-normal" scope="row">
											{row.label}
										</th>
										<td className="py-1 text-right font-mono">
											{row.binding.keys
												.map((combo) => comboLabel(combo, platform))
												.join(", ")}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				))}
			</div>
		</div>
	);
}
