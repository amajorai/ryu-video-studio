/** `import path from "….rnnn" with { type: "file" }` yields the embedded file's path. */
declare module "*.rnnn" {
	const path: string;
	export default path;
}
