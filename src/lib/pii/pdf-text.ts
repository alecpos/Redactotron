import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PdfRect, RedactionBlock } from "../pdf/types.ts";
import type {
  PageTextMap,
  PageTextSegment,
  PiiFinding,
} from "./types.ts";

type PdfJsTextItem = {
  str: string;
  dir: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
};

type PdfJsTextStyle = {
  fontFamily?: string;
};

function isTextItem(value: unknown): value is PdfJsTextItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string"
  );
}

let measurementContext: CanvasRenderingContext2D | null | undefined;

function getMeasurementContext() {
  if (measurementContext !== undefined) return measurementContext;
  if (typeof globalThis.document === "undefined") {
    measurementContext = null;
    return measurementContext;
  }
  measurementContext = globalThis.document
    .createElement("canvas")
    .getContext("2d");
  return measurementContext;
}

function measuredFraction(
  text: string,
  index: number,
  fontFamily: string,
) {
  if (index <= 0) return 0;
  if (index >= text.length) return 1;
  const context = getMeasurementContext();
  if (!context) return index / text.length;
  context.font = `100px ${fontFamily || "sans-serif"}`;
  const total = context.measureText(text).width;
  if (!Number.isFinite(total) || total <= 0) return index / text.length;
  return context.measureText(text.slice(0, index)).width / total;
}

function rangeRect(
  segment: Pick<
    PageTextSegment,
    "text" | "dir" | "transform" | "width" | "height" | "fontFamily"
  >,
  localStart: number,
  localEnd: number,
): PdfRect {
  let from = measuredFraction(segment.text, localStart, segment.fontFamily);
  let to = measuredFraction(segment.text, localEnd, segment.fontFamily);
  if (segment.dir === "rtl") {
    [from, to] = [1 - to, 1 - from];
  }

  const [a, b, , , x, y] = segment.transform;
  const magnitude = Math.hypot(a, b) || 1;
  const alongX = a / magnitude;
  const alongY = b / magnitude;
  const normalX = -alongY;
  const normalY = alongX;
  const height = Math.max(segment.height, magnitude);
  const descent = -height * 0.22;
  const ascent = height * 0.9;
  const startX = x + alongX * segment.width * from;
  const startY = y + alongY * segment.width * from;
  const endX = x + alongX * segment.width * to;
  const endY = y + alongY * segment.width * to;
  const points = [
    [startX + normalX * descent, startY + normalY * descent],
    [startX + normalX * ascent, startY + normalY * ascent],
    [endX + normalX * descent, endY + normalY * descent],
    [endX + normalX * ascent, endY + normalY * ascent],
  ];
  const pad = Math.max(0.5, height * 0.12);
  return {
    x0: Math.min(...points.map(([pointX]) => pointX)) - pad,
    y0: Math.min(...points.map(([, pointY]) => pointY)) - pad,
    x1: Math.max(...points.map(([pointX]) => pointX)) + pad,
    y1: Math.max(...points.map(([, pointY]) => pointY)) + pad,
  };
}

function itemRect(item: PdfJsTextItem, style?: PdfJsTextStyle): PdfRect {
  return rangeRect(
    {
      text: item.str,
      dir: item.dir,
      transform: item.transform,
      width: item.width,
      height: item.height,
      fontFamily: style?.fontFamily ?? "sans-serif",
    },
    0,
    item.str.length,
  );
}

export async function extractPageText(
  document: PDFDocumentProxy,
  pageIndex: number,
): Promise<PageTextMap> {
  const page = await document.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, PdfJsTextStyle>;
  const segments: PageTextSegment[] = [];
  let text = "";
  let previousEndedLine = false;

  for (const rawItem of content.items) {
    if (!isTextItem(rawItem) || !rawItem.str) continue;
    const separator =
      text.length === 0
        ? ""
        : previousEndedLine
          ? "\n"
          : /\s$/u.test(text) || /^\s/u.test(rawItem.str)
            ? ""
            : " ";
    text += separator;
    const start = text.length;
    text += rawItem.str;
    segments.push({
      start,
      end: text.length,
      text: rawItem.str,
      dir: rawItem.dir,
      rect: itemRect(rawItem, styles[rawItem.fontName]),
      transform: rawItem.transform,
      width: rawItem.width,
      height: rawItem.height,
      fontFamily: styles[rawItem.fontName]?.fontFamily ?? "sans-serif",
    });
    previousEndedLine = rawItem.hasEOL;
  }
  return { pageIndex, text, segments };
}

function rectForOverlap(
  segment: PageTextSegment,
  start: number,
  end: number,
): PdfRect {
  return rangeRect(
    segment,
    Math.max(0, start - segment.start),
    Math.min(segment.text.length, end - segment.start),
  );
}

export function findingToBlock(
  page: PageTextMap,
  finding: PiiFinding,
): RedactionBlock | null {
  const rects = page.segments
    .filter(
      (segment) => segment.end > finding.start && segment.start < finding.end,
    )
    .map((segment) =>
      rectForOverlap(
        segment,
        Math.max(segment.start, finding.start),
        Math.min(segment.end, finding.end),
      ),
    )
    .filter((rect) => rect.x1 > rect.x0 && rect.y1 > rect.y0);

  if (!rects.length) return null;
  const labelRectIndex = rects.reduce(
    (largest, rect, index) =>
      (rect.x1 - rect.x0) * (rect.y1 - rect.y0) >
      (rects[largest].x1 - rects[largest].x0) *
        (rects[largest].y1 - rects[largest].y0)
        ? index
        : largest,
    0,
  );

  return {
    id: crypto.randomUUID(),
    pageIndex: page.pageIndex,
    rects,
    labelRectIndex,
    replacement: "REDACTED",
    appearance: "text-replacement",
    suggestion: {
      category: finding.category,
      confidence: finding.confidence,
      source: finding.source,
    },
  };
}
