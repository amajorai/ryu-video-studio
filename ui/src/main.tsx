import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { studioMessageOverlays } from "./i18n/catalog.ts";
import { StudioLocaleSync } from "./i18n/format.ts";
import "./studio.css";

subscribeCompanionTheme();
const messageOverlays = studioMessageOverlays();
const root = document.getElementById("ryu-plugin-root");
if (root) {
	markCompanionAppRoot(root, { surface: "editor" });
	createRoot(root).render(
		<RyuAppShell messageOverlays={messageOverlays} surface="editor">
			<StudioLocaleSync />
			<App />
		</RyuAppShell>
	);
}
