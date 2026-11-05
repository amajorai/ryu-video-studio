/**
 * Route-module registry for the Video Studio sidecar.
 *
 * Each feature that adds or owns an endpoint exports `routes: StudioRoute[]`
 * from `routes/<module>.ts`. `createStudioServer` tries its built-in handlers
 * first and then dispatches unmatched requests here before answering 404.
 * `openapi()` appends every registered operation, so a route module is the
 * single place that describes its handler, body, and agent documentation.
 */
import { z } from "zod";
import type { Asset, Project } from "../../../shared/project.ts";
import type { AnalysisQueue } from "../analysis.ts";
import type { RenderQueue } from "../render.ts";
import type { StudioStore } from "../store.ts";

export const STUDIO_PREFIX = "/api/video-studio";

export type StudioMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

// OpenAPI 3.1 also permits nullable unions in the JSON Schema `type` keyword.
export type StudioJsonSchema = Omit<
	z.core.JSONSchema.JSONSchema,
	"type" | "properties"
> & {
	type?:
		| z.core.JSONSchema.JSONSchema["type"]
		| NonNullable<z.core.JSONSchema.JSONSchema["type"]>[];
	properties?: Record<string, StudioJsonSchema | boolean>;
};

export interface StudioQueryParameter {
	name: string;
	required?: boolean;
	schema: StudioJsonSchema;
}

export interface StudioOperation {
	/** Request body contract, converted with `z.toJSONSchema`. */
	body?: z.ZodType;
	/**
	 * Documented body that overrides `body` in OpenAPI. Kept for handlers
	 * whose published contract predates the registry and must stay stable.
	 */
	bodyJsonSchema?: StudioJsonSchema;
	description: string;
	id: string;
	query?: StudioQueryParameter[];
}

export interface OperationParameter {
	in: "path" | "query";
	name: string;
	required?: boolean;
	schema: StudioJsonSchema;
}

export interface OperationDescription {
	description: string;
	operationId: string;
	parameters?: OperationParameter[];
	requestBody?: {
		required: boolean;
		content: { "application/json": { schema: StudioJsonSchema } };
	};
	responses: Record<string, { description: string }>;
}

/** Shared server state a route handler may use; built once per server. */
/** A finished chunked upload handed to a route that stores it itself. */
export interface ClaimedUpload {
	/** Remove the temporary file and release its storage reservation. */
	dispose: () => Promise<void>;
	name: string;
	path: string;
	size: number;
}

export interface StudioRouteServices {
	analyses: AnalysisQueue;
	/**
	 * Take a completed `/uploads` session out of the media upload flow, for a
	 * route that stores the bytes somewhere other than the media library (an
	 * imported font). Throws when the upload is unknown, busy or incomplete.
	 */
	claimUpload: (id: string) => ClaimedUpload;
	/** Revision-checked read of a project before slow media work starts. */
	currentProject: (id: string, revision: number, message: string) => Project;
	/** Extract embedded audio for video assets under one media admission. */
	extractMissingAudio: (
		assetIds: Iterable<string>,
		signal: AbortSignal
	) => Promise<void>;
	json: <Payload>(body: Payload, status?: number) => Response;
	/** Abort signal for media work: request disconnect or server shutdown. */
	mediaSignal: (request: Request) => AbortSignal;
	/** Bodies of read-only plan routes may be empty. */
	optionalBody: (request: Request) => Promise<unknown>;
	queue: RenderQueue;
	revisionedProjectEdit: (
		id: string,
		revision: number,
		message: string,
		apply: (project: Project, assets: readonly Asset[]) => Project
	) => Response;
	/** Abort signal for soundtrack generation. */
	soundtrackSignal: (request: Request) => AbortSignal;
	store: StudioStore;
	uploadLimits: { chunkSize: number; maxMediaBytes: number };
}

export interface StudioRouteContext extends StudioRouteServices {
	method: string;
	request: Request;
	url: URL;
}

export interface ProjectRouteContext extends StudioRouteContext {
	id: string;
}

export interface AssetRouteContext extends StudioRouteContext {
	asset: Asset;
	id: string;
}

type RouteResult = Response | Promise<Response>;

interface RouteBase {
	method: StudioMethod;
	operation: StudioOperation;
}

/** `POST /projects/:id/<action>[/<subaction>]`. */
export interface ProjectRoute extends RouteBase {
	action: string;
	handle: (context: ProjectRouteContext) => RouteResult;
	scope: "project";
	/** When omitted, the request must not carry a subaction segment. */
	subaction?: string;
}

/** `GET /assets/:id/<action>[/<subaction>]`; the asset is resolved first. */
export interface AssetRoute extends RouteBase {
	action: string;
	handle: (context: AssetRouteContext) => RouteResult;
	scope: "asset";
	subaction?: string;
}

/** `GET /<path>` at the API root with no id segment. */
export interface RootRoute extends RouteBase {
	handle: (context: StudioRouteContext) => RouteResult;
	path: string;
	scope: "root";
}

/**
 * `METHOD /<resource>/:id/<action>` for a root resource other than projects
 * and assets (for example `POST /templates/:id/instantiate`). The id is the
 * parsed uuid segment; the handler resolves it.
 */
export interface ItemRoute extends RouteBase {
	action: string;
	handle: (context: ProjectRouteContext) => RouteResult;
	resource: string;
	scope: "item";
}

export type StudioRoute = ProjectRoute | AssetRoute | RootRoute | ItemRoute;

export interface StudioRequestTarget {
	action?: string;
	/** Parsed id segment, absent for root resources. */
	id?: string;
	method: string;
	resource?: string;
	subaction?: string;
}

const scopeResource = { asset: "assets", project: "projects" } as const;

/** Find the first registered route for a parsed request target. */
export function matchStudioRoute(
	routes: readonly StudioRoute[],
	target: StudioRequestTarget
): StudioRoute | undefined {
	for (const route of routes) {
		if (route.method !== target.method) {
			continue;
		}
		if (route.scope === "root") {
			if (target.resource === route.path && target.id === undefined) {
				return route;
			}
			continue;
		}
		if (route.scope === "item") {
			if (
				target.resource === route.resource &&
				target.id !== undefined &&
				target.action === route.action &&
				!target.subaction
			) {
				return route;
			}
			continue;
		}
		if (
			target.resource === scopeResource[route.scope] &&
			target.id !== undefined &&
			target.action === route.action &&
			(target.subaction || undefined) === route.subaction
		) {
			return route;
		}
	}
	return undefined;
}

/**
 * Dispatch a request to the registry. Returns `undefined` when no route
 * matches so the caller can answer its own 404.
 */
export async function dispatchStudioRoute(
	routes: readonly StudioRoute[],
	target: StudioRequestTarget,
	context: StudioRouteContext
): Promise<Response | undefined> {
	const route = matchStudioRoute(routes, target);
	if (!route) {
		return undefined;
	}
	if (route.scope === "root") {
		return await route.handle(context);
	}
	const id = target.id;
	if (id === undefined) {
		return undefined;
	}
	if (route.scope === "project" || route.scope === "item") {
		return await route.handle({ ...context, id });
	}
	const asset = context.store.assets().find((item) => item.id === id);
	if (!asset) {
		return context.json(
			{ code: "NOT_FOUND", message: "Media not found." },
			404
		);
	}
	return await route.handle({ ...context, asset, id });
}

/** OpenAPI path for a registered route, using `{id}` path parameters. */
export function studioRoutePath(route: StudioRoute): string {
	if (route.scope === "root") {
		return `${STUDIO_PREFIX}/${route.path}`;
	}
	if (route.scope === "item") {
		return `${STUDIO_PREFIX}/${route.resource}/{id}/${route.action}`;
	}
	const tail = route.subaction
		? `${route.action}/${route.subaction}`
		: route.action;
	return `${STUDIO_PREFIX}/${scopeResource[route.scope]}/{id}/${tail}`;
}

const standardResponses = (): OperationDescription["responses"] => ({
	"200": { description: "Successful operation" },
	"400": { description: "Invalid request" },
	"401": { description: "Unauthorized" },
	"409": { description: "Revision conflict" },
	"429": {
		description:
			"Soundtrack concurrency is full; retry after an active soundtrack finishes",
	},
});

/**
 * Build one OpenAPI operation. Matches the shape the server has always
 * published so moved handlers keep a stable contract.
 */
export function describeOperation(
	id: string,
	description: string,
	body?: StudioJsonSchema,
	pathParameter = false,
	query?: StudioQueryParameter | StudioQueryParameter[]
): OperationDescription {
	const result: OperationDescription = {
		operationId: id,
		description,
		responses: standardResponses(),
	};
	if (pathParameter || query) {
		const parameters: OperationParameter[] = [];
		if (pathParameter) {
			parameters.push({
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", format: "uuid" },
			});
		}
		if (query) {
			for (const item of Array.isArray(query) ? query : [query]) {
				parameters.push({
					name: item.name,
					in: "query",
					required: item.required ?? false,
					schema: item.schema,
				});
			}
		}
		result.parameters = parameters;
	}
	if (body) {
		result.requestBody = {
			required: true,
			content: { "application/json": { schema: body } },
		};
	}
	return result;
}

function routeOperation(route: StudioRoute): OperationDescription {
	const { operation } = route;
	const body =
		operation.bodyJsonSchema ??
		(operation.body ? z.toJSONSchema(operation.body) : undefined);
	return describeOperation(
		operation.id,
		operation.description,
		body,
		route.scope !== "root",
		operation.query
	);
}

export type OpenApiPaths = Record<string, Record<string, OperationDescription>>;

/**
 * List `METHOD path` keys where a registry route would share a path and
 * method with a built-in operation or an earlier registry route. Built-in
 * handlers in `server.ts` run first and the registry dispatches its first
 * match, so such a route could never answer; it is a programming error.
 */
export function findRouteCollisions(
	paths: OpenApiPaths,
	routes: readonly StudioRoute[]
): string[] {
	const collisions: string[] = [];
	const registered = new Set<string>();
	for (const route of routes) {
		const path = studioRoutePath(route);
		const key = `${route.method} ${path}`;
		if (paths[path]?.[route.method.toLowerCase()] || registered.has(key)) {
			collisions.push(key);
		}
		registered.add(key);
	}
	return collisions;
}

/**
 * Merge registry operations into a set of built-in OpenAPI paths. Built-in
 * handlers are dispatched before the registry, so a registry route at an
 * existing built-in path and method would be published but never run; that
 * collision throws instead of silently replacing the built-in operation.
 */
export function mergeRouteOperations(
	paths: OpenApiPaths,
	routes: readonly StudioRoute[]
): OpenApiPaths {
	const collisions = findRouteCollisions(paths, routes);
	if (collisions.length > 0) {
		throw new Error(
			`Video Studio registry routes shadowed by an earlier handler: ${collisions.join(", ")}`
		);
	}
	const merged: OpenApiPaths = { ...paths };
	for (const route of routes) {
		const path = studioRoutePath(route);
		merged[path] = {
			...merged[path],
			[route.method.toLowerCase()]: routeOperation(route),
		};
	}
	return merged;
}

/** JSON response that is never cached by the host proxy. */
export function studioJson<Payload>(body: Payload, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
