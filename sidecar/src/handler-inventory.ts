/**
 * The Video Studio HTTP handler inventory as `METHOD /path` keys (manifest
 * syntax, `:id` for the uuid segment). Built-in handlers are read from the
 * `createStudioServer` dispatch source; registry handlers come from the route
 * modules. `verify-package.ts` and `openapi.test.ts` compare this inventory
 * with `manifest.json` and `/openapi.json`, so a handler can't ship without a
 * manifest route (the host proxy would refuse it) or the reverse.
 */
import {
	STUDIO_PREFIX,
	type StudioRoute,
	studioRoutePath,
} from "./routes/registry.ts";

const DISPATCH_START = "const method = request.method;";
const DISPATCH_END = "const routed = await dispatchStudioRoute(";

/** Every `if (...)` condition in `text`, with balanced parentheses. */
function conditions(text: string): string[] {
	const found: string[] = [];
	let index = text.indexOf("if (");
	while (index !== -1) {
		let depth = 0;
		let end = index + 3;
		for (; end < text.length; end += 1) {
			const char = text[end];
			if (char === "(") {
				depth += 1;
			} else if (char === ")") {
				depth -= 1;
				if (depth === 0) {
					break;
				}
			}
		}
		found.push(text.slice(index + 4, end).replace(/\s+/g, " "));
		index = text.indexOf("if (", end);
	}
	return found;
}

const literal = (condition: string, name: string): string | undefined =>
	new RegExp(`(?:^|[^.\\w])${name} === "([^"]+)"`).exec(condition)?.[1];

const METHOD_TOKEN = /(?:^|[^\w])method\b/g;
const METHOD_LITERAL = /(?:^|[^.\w])method === "[A-Z]+"/;

/**
 * Fail closed on dispatch conditions the parser can't read exactly: any
 * `request.method`/`x.method`, `pathname` test, `method !==`, `.includes(method)`
 * or a second `method` mention would otherwise be skipped or mis-keyed, and the
 * parity checks would pass while a handler has no manifest route.
 */
function assertReadableMethodCondition(condition: string): void {
	const mentions = condition.match(METHOD_TOKEN) ?? [];
	const unreadable =
		/\bpathname\b/.test(condition) ||
		/\.method\b/.test(condition) ||
		mentions.length > 1 ||
		(mentions.length === 1 && !METHOD_LITERAL.test(condition));
	if (unreadable) {
		throw new Error(
			`Unreadable dispatch condition (use \`… && method === "VERB"\`): ${condition}`
		);
	}
}

/**
 * `METHOD /path` keys for the built-in handlers in `server.ts` source. Each
 * dispatch condition names its method and, within a `resource` block, the
 * id (`id`, `!id`, a `rawId` literal), `action` and `subaction` it accepts.
 * Asset, upload and render handlers below the id lookup take the id
 * implicitly.
 */
export function builtinHandlerKeys(serverSource: string): string[] {
	const start = serverSource.indexOf(DISPATCH_START);
	const end = serverSource.indexOf(DISPATCH_END, start);
	if (start === -1 || end === -1) {
		throw new Error("server.ts dispatch section not found.");
	}
	const section = serverSource.slice(start, end);
	if (/switch \(\s*(?:request\.)?method\b/.test(section)) {
		throw new Error(
			"server.ts dispatches on method with a switch; use if conditions."
		);
	}
	const keys: string[] = [];
	let resource: string | undefined;
	for (const condition of conditions(section)) {
		assertReadableMethodCondition(condition);
		const ownResource = literal(condition, "resource");
		const method = literal(condition, "method");
		if (!method) {
			if (ownResource) {
				resource = ownResource;
			}
			continue;
		}
		const target = ownResource ?? resource;
		if (!target) {
			throw new Error(`Handler without a resource: ${condition}`);
		}
		const rawId = literal(condition, "rawId");
		const noId = /!(?:raw)?[iI]d\b/.test(condition);
		const mentionsId = /\b(?:raw)?[iI]d\b/.test(condition);
		let path = `/${target}`;
		if (rawId) {
			path += `/${rawId}`;
		} else if (!(noId || (ownResource && !mentionsId))) {
			path += "/:id";
		}
		const action = literal(condition, "action");
		if (action) {
			path += `/${action}`;
		}
		const subaction = literal(condition, "subaction");
		if (subaction) {
			path += `/${subaction}`;
		}
		keys.push(`${method} ${path}`);
	}
	return keys;
}

/** Manifest-syntax path for a registry route. */
export function registryHandlerKey(route: StudioRoute): string {
	const path = studioRoutePath(route)
		.slice(STUDIO_PREFIX.length)
		.replace(/\{(\w+)\}/g, ":$1");
	return `${route.method} ${path}`;
}

/** `METHOD /path` keys for an OpenAPI `paths` object under the studio prefix. */
export function openapiKeys(
	paths: Record<string, Record<string, unknown>>
): string[] {
	const keys: string[] = [];
	for (const [path, operations] of Object.entries(paths)) {
		const local = path.slice(STUDIO_PREFIX.length).replace(/\{(\w+)\}/g, ":$1");
		for (const method of Object.keys(operations)) {
			keys.push(`${method.toUpperCase()} ${local}`);
		}
	}
	return keys;
}

export interface InventoryDiff {
	duplicates: string[];
	extra: string[];
	missing: string[];
}

/**
 * Compare declared keys (the manifest) with handler keys: `missing` handlers
 * have no declaration, `extra` declarations have no handler, `duplicates`
 * appear more than once on either side.
 */
export function diffInventory(
	declared: readonly string[],
	handlers: readonly string[]
): InventoryDiff {
	const repeated = (keys: readonly string[]) =>
		keys.filter((key, index) => keys.indexOf(key) !== index);
	const declaredSet = new Set(declared);
	const handlerSet = new Set(handlers);
	return {
		duplicates: [...new Set([...repeated(declared), ...repeated(handlers)])],
		extra: [...declaredSet].filter((key) => !handlerSet.has(key)),
		missing: [...handlerSet].filter((key) => !declaredSet.has(key)),
	};
}
