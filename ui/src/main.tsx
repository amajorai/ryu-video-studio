import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./studio.css";

subscribeCompanionTheme();
const root = document.getElementById("ryu-plugin-root");
if (root) {
	markCompanionAppRoot(root, { surface: "editor" });
	createRoot(root).render(
		<RyuAppShell surface="editor">
			<App />
		</RyuAppShell>
	);
}
