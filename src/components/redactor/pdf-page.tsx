"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  PDFDocumentProxy,
} from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import { CloseIcon } from "@/components/icons";
import type {
  PdfRect,
  RedactionBlock,
  ToolMode,
} from "@/lib/pdf/types";

type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const REPLACEMENT_WIDTH_EM = 5.56;

type PdfPageProps = {
  document: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  mode: ToolMode;
  blocks: RedactionBlock[];
  selectedBlockId: string | null;
  onAddBlock: (block: RedactionBlock) => void;
  onRemoveBlock: (id: string) => void;
  onSelectBlock: (id: string | null) => void;
  onTextLayerStatus: (pageIndex: number, hasText: boolean) => void;
};

function normalizePdfRect(points: number[]): PdfRect {
  return {
    x0: Math.min(points[0], points[2]),
    y0: Math.min(points[1], points[3]),
    x1: Math.max(points[0], points[2]),
    y1: Math.max(points[1], points[3]),
  };
}

function toScreenRect(
  viewport: PageViewport,
  rect: PdfRect,
): ScreenRect {
  const first = viewport.convertToViewportPoint(rect.x0, rect.y0);
  const second = viewport.convertToViewportPoint(rect.x1, rect.y1);

  return {
    left: Math.min(first[0], second[0]),
    top: Math.min(first[1], second[1]),
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  };
}

function boundingScreenRect(rects: ScreenRect[]): ScreenRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(
    ...rects.map((rect) => rect.left + rect.width),
  );
  const bottom = Math.max(
    ...rects.map((rect) => rect.top + rect.height),
  );

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function replacementLabelStyle(
  rect: ScreenRect,
  sourceFontSize: number | null,
  viewportScale: number,
) {
  const vertical = rect.height > rect.width;
  const availableWidth = vertical ? rect.height : rect.width;
  const availableHeight = vertical ? rect.width : rect.height;

  // Searchable selections retain one of their original font sizes. Scanned
  // areas have no source metrics, so they continue to use the fitted fallback.
  const fontSize =
    sourceFontSize === null
      ? Math.max(
          4,
          Math.min(
            10,
            (availableWidth * 0.9) / 6,
            availableHeight / 1.25,
          ),
        )
      : sourceFontSize * viewportScale;
  const horizontalScale =
    sourceFontSize === null
      ? 1
      : Math.min(
          1,
          Math.max(
            0.05,
            (availableWidth * 0.9) /
              (fontSize * REPLACEMENT_WIDTH_EM),
          ),
        );
  const transforms = [
    vertical ? "rotate(-90deg)" : "",
    horizontalScale < 1 ? `scaleX(${horizontalScale})` : "",
  ].filter(Boolean);

  return {
    fontSize,
    transform: transforms.length ? transforms.join(" ") : undefined,
  };
}

function overlapArea(first: DOMRect, second: DOMRect) {
  const width =
    Math.min(first.right, second.right) -
    Math.max(first.left, second.left);
  const height =
    Math.min(first.bottom, second.bottom) -
    Math.max(first.top, second.top);
  return Math.max(0, width) * Math.max(0, height);
}

function sourceFontSizeForRects(
  textLayer: HTMLDivElement,
  rects: DOMRect[],
  viewportScale: number,
  range?: Range,
) {
  if (rects.length === 0) return null;

  const scores = new Map<number, number>();

  for (const span of textLayer.querySelectorAll("span")) {
    if (range && !range.intersectsNode(span)) continue;

    const spanRect = span.getBoundingClientRect();
    const score = rects.reduce(
      (total, rect) => total + overlapArea(spanRect, rect),
      0,
    );
    if (score <= 0) continue;

    const screenFontSize = Number.parseFloat(
      window.getComputedStyle(span).fontSize,
    );
    const sourceFontSize = screenFontSize / viewportScale;
    if (!Number.isFinite(sourceFontSize) || sourceFontSize <= 0) {
      continue;
    }

    const normalizedSize = Math.round(sourceFontSize * 1000) / 1000;
    scores.set(
      normalizedSize,
      (scores.get(normalizedSize) ?? 0) + score,
    );
  }

  const rankedSizes = [...scores.entries()].sort(
    (first, second) => second[1] - first[1],
  );
  const labelRect = rects.reduce(
    (largest, rect) =>
      rect.width * rect.height > largest.width * largest.height
        ? rect
        : largest,
  );
  const availableHeight =
    labelRect.height > labelRect.width
      ? labelRect.width
      : labelRect.height;
  return (
    rankedSizes.find(
      ([fontSize]) => fontSize * viewportScale <= availableHeight,
    )?.[0] ?? null
  );
}

function mergeLineRects(rects: DOMRect[]): DOMRect[] {
  const sorted = [...rects].sort(
    (a, b) => a.top - b.top || a.left - b.left,
  );
  const merged: DOMRect[] = [];

  for (const rect of sorted) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push(rect);
      continue;
    }

    const overlap =
      Math.min(previous.bottom, rect.bottom) -
      Math.max(previous.top, rect.top);
    const minHeight = Math.min(previous.height, rect.height);
    const horizontalGap = rect.left - previous.right;

    if (
      minHeight > 0 &&
      overlap / minHeight >= 0.7 &&
      horizontalGap <= 5
    ) {
      merged[merged.length - 1] = new DOMRect(
        Math.min(previous.left, rect.left),
        Math.min(previous.top, rect.top),
        Math.max(previous.right, rect.right) -
          Math.min(previous.left, rect.left),
        Math.max(previous.bottom, rect.bottom) -
          Math.min(previous.top, rect.top),
      );
    } else {
      merged.push(rect);
    }
  }

  return merged;
}

export function PdfPage({
  document,
  pageIndex,
  scale,
  mode,
  blocks,
  selectedBlockId,
  onAddBlock,
  onRemoveBlock,
  onSelectBlock,
  onTextLayerStatus,
}: PdfPageProps) {
  const pageRootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [hasSelectableText, setHasSelectableText] = useState<boolean | null>(
    null,
  );
  const [dragStart, setDragStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null =
      null;
    let textLayer: { cancel: () => void; render: () => Promise<void> } | null =
      null;

    async function renderPage() {
      const [{ TextLayer }, page] = await Promise.all([
        import("pdfjs-dist"),
        document.getPage(pageIndex + 1),
      ]);
      if (cancelled) return;

      const nextViewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const textContainer = textLayerRef.current;
      if (!canvas || !textContainer) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(nextViewport.width * pixelRatio);
      canvas.height = Math.floor(nextViewport.height * pixelRatio);
      canvas.style.width = `${nextViewport.width}px`;
      canvas.style.height = `${nextViewport.height}px`;

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas rendering is unavailable.");

      textContainer.replaceChildren();
      textContainer.style.width = `${nextViewport.width}px`;
      textContainer.style.height = `${nextViewport.height}px`;

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport: nextViewport,
        transform:
          pixelRatio === 1
            ? undefined
            : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });

      const textContent = await page.getTextContent();
      const nextHasSelectableText = textContent.items.some(
        (item) => "str" in item && item.str.trim().length > 0,
      );
      setHasSelectableText(nextHasSelectableText);
      onTextLayerStatus(pageIndex, nextHasSelectableText);
      textLayer = new TextLayer({
        textContentSource: textContent,
        container: textContainer,
        viewport: nextViewport,
      });

      await Promise.all([renderTask.promise, textLayer.render()]);
      if (!cancelled) {
        setViewport(nextViewport);
        setRenderError(null);
      }
    }

    renderPage().catch((error: unknown) => {
      if (cancelled || (error instanceof Error && error.name === "RenderingCancelledException")) {
        return;
      }
      setRenderError("This page could not be rendered.");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [document, onTextLayerStatus, pageIndex, scale]);

  const createBlock = useCallback(
    (rects: PdfRect[], sourceFontSize: number | null) => {
      const valid = rects.filter(
        (rect) =>
          [rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite) &&
          rect.x1 - rect.x0 > 0.5 &&
          rect.y1 - rect.y0 > 0.5,
      );
      if (!valid.length) return;

      const labelRectIndex = valid.reduce(
        (best, rect, index, all) =>
          (rect.x1 - rect.x0) * (rect.y1 - rect.y0) >
          (all[best].x1 - all[best].x0) *
            (all[best].y1 - all[best].y0)
            ? index
            : best,
        0,
      );

      onAddBlock({
        id: crypto.randomUUID(),
        pageIndex,
        rects: valid,
        labelRectIndex,
        sourceFontSize,
        replacement: "REDACTED",
        appearance: "text-replacement",
      });
    },
    [onAddBlock, pageIndex],
  );

  const handleTextSelection = useCallback(() => {
    if (mode !== "text" || !viewport || !pageRootRef.current) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const textLayer = textLayerRef.current;
    if (
      !textLayer ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !textLayer.contains(selection.anchorNode) ||
      !textLayer.contains(selection.focusNode)
    ) {
      return;
    }

    const pageBounds = pageRootRef.current.getBoundingClientRect();
    const range = selection.getRangeAt(0);
    const clientRects = Array.from(
      range.getClientRects(),
    ).filter(
      (rect) =>
        rect.width > 1 &&
        rect.height > 1 &&
        rect.right > pageBounds.left &&
        rect.left < pageBounds.right &&
        rect.bottom > pageBounds.top &&
        rect.top < pageBounds.bottom,
    );

    const merged = mergeLineRects(clientRects);
    const pdfRects = merged.map((rect) => {
      const left = Math.max(0, rect.left - pageBounds.left);
      const top = Math.max(0, rect.top - pageBounds.top);
      const right = Math.min(
        viewport.width,
        rect.right - pageBounds.left,
      );
      const bottom = Math.min(
        viewport.height,
        rect.bottom - pageBounds.top,
      );
      const first = viewport.convertToPdfPoint(left, top);
      const second = viewport.convertToPdfPoint(right, bottom);
      return normalizePdfRect([...first, ...second]);
    });

    createBlock(
      pdfRects,
      sourceFontSizeForRects(
        textLayer,
        clientRects,
        viewport.scale,
        range,
      ),
    );
    selection.removeAllRanges();
  }, [createBlock, mode, viewport]);

  const pointerPosition = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  };

  const handleAreaStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== "area" || event.button !== 0) return;
    const point = pointerPosition(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDragCurrent(point);
    onSelectBlock(null);
  };

  const handleAreaMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart || mode !== "area") return;
    setDragCurrent(pointerPosition(event));
  };

  const handleAreaEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart || !dragCurrent || mode !== "area" || !viewport) return;
    const end = pointerPosition(event);
    const width = Math.abs(end.x - dragStart.x);
    const height = Math.abs(end.y - dragStart.y);
    setDragStart(null);
    setDragCurrent(null);

    if (width < 8 || height < 8) return;

    const first = viewport.convertToPdfPoint(dragStart.x, dragStart.y);
    const second = viewport.convertToPdfPoint(end.x, end.y);
    const pageBounds = pageRootRef.current?.getBoundingClientRect();
    const textLayer = textLayerRef.current;
    const sourceFontSize =
      pageBounds && textLayer
        ? sourceFontSizeForRects(
            textLayer,
            [
              new DOMRect(
                pageBounds.left + Math.min(dragStart.x, end.x),
                pageBounds.top + Math.min(dragStart.y, end.y),
                width,
                height,
              ),
            ],
            viewport.scale,
          )
        : null;
    createBlock(
      [normalizePdfRect([...first, ...second])],
      sourceFontSize,
    );
  };

  const draftScreenRect = useMemo<ScreenRect | null>(() => {
    if (!dragStart || !dragCurrent) return null;
    return {
      left: Math.min(dragStart.x, dragCurrent.x),
      top: Math.min(dragStart.y, dragCurrent.y),
      width: Math.abs(dragCurrent.x - dragStart.x),
      height: Math.abs(dragCurrent.y - dragStart.y),
    };
  }, [dragCurrent, dragStart]);

  return (
    <section
      className="page-stage"
      aria-label={`Page ${pageIndex + 1}`}
      id={`page-${pageIndex + 1}`}
    >
      <div className="page-number-pill">{pageIndex + 1}</div>
      <div
        ref={pageRootRef}
        className={`pdf-page ${mode === "area" ? "area-mode" : ""}`}
        style={
          viewport
            ? { width: viewport.width, height: viewport.height }
            : undefined
        }
        onPointerUp={(event) => {
          handleAreaEnd(event);
          handleTextSelection();
        }}
        onPointerDown={handleAreaStart}
        onPointerMove={handleAreaMove}
        onPointerCancel={() => {
          setDragStart(null);
          setDragCurrent(null);
        }}
      >
        <canvas ref={canvasRef} className="pdf-canvas" />
        <div ref={textLayerRef} className="textLayer" />

        {hasSelectableText === false && (
          <div className="scan-page-warning" role="status">
            No selectable text on this page. Draw a box to mark an area.
          </div>
        )}

        <div className="redaction-layer" aria-live="polite">
          {viewport &&
            blocks.map((block) => {
              const screenRects = block.rects.map((rect) =>
                toScreenRect(viewport, rect),
              );
              const bounds = boundingScreenRect(screenRects);
              const selected = block.id === selectedBlockId;

              return (
                <div
                  key={block.id}
                  className={`redaction-block ${selected ? "selected" : ""}`}
                  style={bounds}
                >
                  {screenRects.map((screen, index) => (
                    <div
                      key={`${block.id}-${index}`}
                      className={`redaction-mark ${
                        block.suggestion ? "suggestion" : ""
                      }`}
                      style={{
                        left: screen.left - bounds.left,
                        top: screen.top - bounds.top,
                        width: screen.width,
                        height: screen.height,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        onSelectBlock(block.id);
                      }}
                    >
                      {index === block.labelRectIndex && (
                        <span
                          className="redaction-label"
                          style={replacementLabelStyle(
                            screen,
                            block.sourceFontSize,
                            viewport.scale,
                          )}
                        >
                          REDACTED
                        </span>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="remove-mark"
                    aria-label={`Remove redaction on page ${pageIndex + 1}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onRemoveBlock(block.id)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              );
            })}

          {draftScreenRect && (
            <div className="redaction-mark drawing" style={draftScreenRect}>
              <span
                className="redaction-label"
                style={replacementLabelStyle(
                  draftScreenRect,
                  null,
                  viewport?.scale ?? 1,
                )}
              >
                REDACTED
              </span>
            </div>
          )}
        </div>

        {renderError && <div className="page-error">{renderError}</div>}
      </div>
    </section>
  );
}
