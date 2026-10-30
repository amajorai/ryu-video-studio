/**
 * The preview now lives in `./preview/*` (one module per layer and stage).
 * This path stays as the stable import for `App.tsx`.
 */
export type { PreviewStageProps as PreviewProps } from "./preview/PreviewStage.tsx";
export { PreviewStage as Preview } from "./preview/PreviewStage.tsx";
