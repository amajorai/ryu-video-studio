import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	handoffScopeFor,
	onAgentHandoffRequest,
} from "../editor/actions/ai.ts";
import { useEditorProject } from "../editor/context.tsx";
import {
	AGENT_HANDOFF_GRANT,
	composeAgentHandoff,
	type HandoffConversation,
	type HandoffScope,
	hostChat,
	isChatAccessDenied,
	listHandoffConversations,
	MAX_HANDOFF_QUESTION_CHARS,
	sendAgentHandoff,
} from "./agent-bridge.ts";

type SendState =
	| { kind: "idle" }
	| { kind: "sending" }
	| { kind: "sent"; title: string }
	| { kind: "error"; message: string };

/** Short description of what the agent will be asked about. */
export function describeHandoffScope(scope: HandoffScope): string {
	const clips =
		scope.clipIds.length === 1 ? "1 clip" : `${scope.clipIds.length} clips`;
	const range = scope.range
		? `${scope.range.start.toFixed(2)}s-${scope.range.end.toFixed(2)}s`
		: "the whole timeline";
	const markers = scope.markerIds?.length ?? 0;
	if (markers > 0) {
		return `${markers === 1 ? "a marker" : `${markers} markers`} at ${range}`;
	}
	return scope.clipIds.length > 0 ? `${clips} in ${range}` : range;
}

const errorText = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

/**
 * "Ask agent about selection or range": composes the question with the
 * project id, clip ids, time range, and a timeline summary, and posts it as
 * one message into an existing Ryu chat through the host `chat.send` bridge.
 */
export function AgentHandoff({
	initialScope,
}: {
	initialScope?: HandoffScope;
}) {
	const tl = useLiteralMessages();
	const editor = useEditorProject();
	const { assets, dirty, project } = editor;
	const chatAvailable = Boolean(hostChat());
	// The host installs the chat bridge with or without the grant, so access
	// is known to be denied only once a chat call is refused.
	const [accessDenied, setAccessDenied] = useState(!chatAvailable);
	const [scope, setScope] = useState<HandoffScope>(
		() => initialScope ?? handoffScopeFor(editor)
	);
	const [question, setQuestion] = useState("");
	const [conversations, setConversations] = useState<
		HandoffConversation[] | null
	>(null);
	const [conversationId, setConversationId] = useState("");
	const [loadError, setLoadError] = useState("");
	const [sendState, setSendState] = useState<SendState>({ kind: "idle" });

	useEffect(() => onAgentHandoffRequest(setScope), []);

	const loadConversations = useCallback(async () => {
		setLoadError("");
		try {
			const listed = await listHandoffConversations();
			setConversations(listed);
			setConversationId((current) =>
				listed.some((item) => item.id === current)
					? current
					: (listed[0]?.id ?? "")
			);
		} catch (error) {
			if (isChatAccessDenied(error)) {
				setAccessDenied(true);
				return;
			}
			setConversations([]);
			setLoadError(errorText(error, "Chats could not be loaded."));
		}
	}, []);

	useEffect(() => {
		if (chatAvailable) {
			void loadConversations();
		}
	}, [chatAvailable, loadConversations]);

	const message = useMemo(
		() => composeAgentHandoff({ assets, dirty, project, question, scope }),
		[assets, dirty, project, question, scope]
	);

	const send = async () => {
		const target = conversations?.find((item) => item.id === conversationId);
		if (!target) {
			return;
		}
		setSendState({ kind: "sending" });
		try {
			await sendAgentHandoff(target.id, message);
			setSendState({ kind: "sent", title: target.title });
		} catch (error) {
			if (isChatAccessDenied(error)) {
				setSendState({ kind: "idle" });
				setAccessDenied(true);
				return;
			}
			setSendState({
				kind: "error",
				message: errorText(error, "The question could not be sent."),
			});
		}
	};

	if (accessDenied) {
		return (
			<RyuAppSection title="Ask agent">
				<p className="text-muted-foreground text-sm">
					{tl(
						"Ask agent needs chat access. Approve the {grant} permission for Video Studio to send timeline questions to a chat.",
						{ grant: AGENT_HANDOFF_GRANT }
					)}
				</p>
				{chatAvailable ? (
					<RyuAppActions>
						<Button
							onClick={() => {
								setAccessDenied(false);
								void loadConversations();
							}}
							size="sm"
							variant="ghost"
						>
							Check again
						</Button>
					</RyuAppActions>
				) : null}
			</RyuAppSection>
		);
	}

	const sending = sendState.kind === "sending";
	return (
		<RyuAppSection title="Ask agent">
			<p className="text-sm">
				About <strong>{describeHandoffScope(scope)}</strong>
			</p>
			<RyuAppActions>
				<Button
					onClick={() => setScope(handoffScopeFor(editor))}
					size="sm"
					variant="ghost"
				>
					Use current selection
				</Button>
				<Button
					onClick={() => setScope({ clipIds: [], range: null })}
					size="sm"
					variant="ghost"
				>
					Whole timeline
				</Button>
			</RyuAppActions>
			<RyuAppField label="Question">
				<Textarea
					aria-label="Question for the agent"
					maxLength={MAX_HANDOFF_QUESTION_CHARS}
					onChange={(event) => setQuestion(event.target.value)}
					placeholder="What should the agent look at or change?"
					rows={3}
					value={question}
				/>
			</RyuAppField>
			<RyuAppField
				description={
					conversations?.length === 0 && !loadError
						? "Start a chat in Ryu first, then refresh."
						: undefined
				}
				label="Send to chat"
			>
				<NativeSelect
					aria-label="Chat to send to"
					disabled={!conversations?.length}
					onChange={(event) => setConversationId(event.target.value)}
					size="sm"
					value={conversationId}
				>
					{conversations === null ? (
						<NativeSelectOption value="">Loading chats…</NativeSelectOption>
					) : null}
					{conversations?.map((conversation) => (
						<NativeSelectOption key={conversation.id} value={conversation.id}>
							{conversation.title}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<details>
				<summary className="cursor-pointer text-sm">Message preview</summary>
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
					{message}
				</pre>
			</details>
			<RyuAppActions>
				<Button
					disabled={sending || !conversationId}
					onClick={() => void send()}
					size="sm"
				>
					{sending ? "Sending…" : "Ask agent"}
				</Button>
				<Button
					onClick={() => void loadConversations()}
					size="sm"
					variant="ghost"
				>
					Refresh chats
				</Button>
			</RyuAppActions>
			<p aria-live="polite" className="text-sm" role="status">
				{loadError ||
					(sendState.kind === "sent"
						? tl('Sent to "{title}".', { title: sendState.title })
						: sendState.kind === "error"
							? sendState.message
							: "")}
			</p>
		</RyuAppSection>
	);
}
