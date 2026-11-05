/**
 * A glossary pair ("wrong → right") as the catalog's "{from} → {to}" message,
 * so the Arabic pack's mirrored arrow and word order apply. Each side is
 * rendered as its own node (struck through, bold) inside a `<bdi>`, because
 * the words can be Arabic or Latin and must not reorder with the arrow.
 */
import type { LiteralMessage } from "@ryu/i18n/react";
import { Fragment, type ReactNode } from "react";

// Private-use stand-ins for the two sides while the message is formatted.
const FROM_SLOT = "";
const TO_SLOT = "";
const SLOT = /([])/u;

/** "{from} → {to}" in the reader's language with `from` and `to` as nodes. */
export function glossaryPair(
	tl: LiteralMessage,
	from: ReactNode,
	to: ReactNode
): ReactNode {
	const message = tl("{from} → {to}", { from: FROM_SLOT, to: TO_SLOT });
	return message.split(SLOT).map((part, index) => {
		const key = `${index}:${part}`;
		if (part === FROM_SLOT) {
			return <bdi key={key}>{from}</bdi>;
		}
		if (part === TO_SLOT) {
			return <bdi key={key}>{to}</bdi>;
		}
		return <Fragment key={key}>{part}</Fragment>;
	});
}
