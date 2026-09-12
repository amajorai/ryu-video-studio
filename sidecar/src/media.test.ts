import { expect, test } from "bun:test";
import { parseProbeOutput } from "./media.ts";

test("probe parsing retains embedded source timecode and frame rate", () => {
	const parsed = parseProbeOutput(
		JSON.stringify({
			format: { duration: "1", tags: {} },
			streams: [
				{
					avg_frame_rate: "30/1",
					codec_name: "h264",
					codec_type: "video",
					duration: "1",
					height: 180,
					tags: { timecode: "01:02:03:04" },
					width: 320,
				},
			],
		})
	);
	expect(parsed).toMatchObject({
		timecodeFrameRate: 30,
		timecodeStart: "01:02:03:04",
	});
});
