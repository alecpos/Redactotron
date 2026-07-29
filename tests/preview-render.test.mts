import assert from "node:assert/strict";
import test from "node:test";
import {
  describePreviewRenderFailure,
  isPreviewCancellation,
  previewOutputScale,
} from "../src/lib/pdf/preview-render.ts";

test("preview output scale preserves normal pages and bounds oversized scans", () => {
  assert.equal(previewOutputScale(612, 792, 2), 2);

  const oversized = previewOutputScale(5_100, 6_600, 3);
  assert.ok(oversized < 1);
  assert.ok(5_100 * oversized <= 4_096);
  assert.ok(6_600 * oversized <= 4_096);
  assert.ok(5_100 * 6_600 * oversized * oversized <= 4_000_001);
});

test("preview failures distinguish cancellation from canvas limits", () => {
  const cancelled = new Error("TextLayer task cancelled.");
  cancelled.name = "AbortException";
  assert.equal(isPreviewCancellation(cancelled), true);

  assert.deepEqual(
    describePreviewRenderFailure(
      new RangeError("Canvas area exceeds the maximum limit"),
    ),
    {
      code: "PREVIEW_CANVAS_LIMIT",
      detail: "RangeError: Canvas area exceeds the maximum limit",
    },
  );
  assert.equal(
    describePreviewRenderFailure(new Error("Invalid PDF operator")).code,
    "PREVIEW_RENDER",
  );
});
