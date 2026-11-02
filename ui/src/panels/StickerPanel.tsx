import type { PanelTab } from "./types.ts";

export { StickerPanel } from "../stickers/StickerPanel.tsx";

/** Bundled stickers (emoji, flags, shapes) have their own library tab. */
export const stickerPanelTab: PanelTab | null = {
	label: "Stickers",
	value: "stickers",
};
