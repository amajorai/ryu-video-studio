/** `import path from "….ttf" with { type: "file" }` yields the embedded file's path. */
declare module "*.ttf" {
	const path: string;
	export default path;
}

/** `import text from "….svg" with { type: "text" }` yields the file's contents. */
declare module "*.svg" {
	const text: string;
	export default text;
}
