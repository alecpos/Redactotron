const MAX_PREVIEW_CANVAS_PIXELS = 4_000_000;
const MAX_PREVIEW_CANVAS_DIMENSION = 4_096;
const MAX_DEVICE_PIXEL_RATIO = 2;

export type PreviewRenderFailure = {
  code: "PREVIEW_CANVAS_LIMIT" | "PREVIEW_RENDER";
  detail: string;
};

export function previewOutputScale(
  width: number,
  height: number,
  devicePixelRatio: number,
) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return 1;
  }

  const requestedScale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? Math.min(devicePixelRatio, MAX_DEVICE_PIXEL_RATIO)
      : 1;
  const scale = Math.min(
    requestedScale,
    MAX_PREVIEW_CANVAS_DIMENSION / width,
    MAX_PREVIEW_CANVAS_DIMENSION / height,
    Math.sqrt(MAX_PREVIEW_CANVAS_PIXELS / (width * height)),
  );

  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function isPreviewCancellation(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "RenderingCancelledException" ||
    error.name === "AbortException" ||
    /cancel(?:led|ed|lation)/i.test(error.message)
  );
}

export function describePreviewRenderFailure(
  error: unknown,
): PreviewRenderFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error
      ? error.message.replace(/\s+/g, " ").trim().slice(0, 180)
      : "";
  const combined = `${name} ${message}`;
  const canvasLimit =
    /canvas|memory|allocation|surface|dimension|size|area|context/i.test(
      combined,
    );

  return {
    code: canvasLimit ? "PREVIEW_CANVAS_LIMIT" : "PREVIEW_RENDER",
    detail: message ? `${name}: ${message}` : name,
  };
}
