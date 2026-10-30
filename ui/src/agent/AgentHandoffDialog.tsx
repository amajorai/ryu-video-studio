import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import { onAgentHandoffRequest } from "../editor/actions/ai.ts";
import { AgentHandoff } from "./AgentHandoff.tsx";
import type { HandoffScope } from "./agent-bridge.ts";

/**
 * The mounted "Ask agent" surface. It listens for handoff requests (Alt+A,
 * the clip menu's "Ask agent", the toolbar button) and opens a dialog with
 * the handoff form scoped to the selection or marked range at that moment.
 * While it is mounted, `agentHandoffAvailable()` is true, so the shortcut
 * and the menu item are live. Mount once inside the editor provider, only
 * while a project is open.
 */
export function AgentHandoffDialog() {
	const [request, setRequest] = useState<{
		id: number;
		scope: HandoffScope;
	} | null>(null);
	const [open, setOpen] = useState(false);
	useEffect(
		() =>
			onAgentHandoffRequest((scope) => {
				setRequest((current) => ({ id: (current?.id ?? 0) + 1, scope }));
				setOpen(true);
			}),
		[]
	);
	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="sr-only">Ask agent</DialogTitle>
					<DialogDescription className="sr-only">
						Send a question about the selected clips or marked range to a Ryu
						chat.
					</DialogDescription>
				</DialogHeader>
				{open && request ? (
					<AgentHandoff initialScope={request.scope} key={request.id} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
