import { expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { volumePointTitle } from "./ClipVolumeLine-point-title.ts";

test("a volume keyframe tooltip is one message in the UI language", () => {
	const japanese = (source: string, values?: MessageValuesInput) =>
		formatMessage(
			source === "{level} at {time}" ? "{time} の {level}" : source,
			values,
			"ja"
		);
	const title = volumePointTitle(japanese, { time: 2, value: 1 });
	expect(title).toMatch(/^\S+ の .*dB$/u);
	expect(title).not.toContain(" at ");
	expect(
		volumePointTitle((source, values) => formatMessage(source, values, "en"), {
			time: 2,
			value: 1,
		})
	).toMatch(/dB at /u);
});
