import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PdfRect, RedactionBlock } from "@/lib/pdf/types";
import type {
  PageTextMap,
  PageTextSegment,
  PiiFinding,
} from "@/lib/pii/types";

type PdfJsTextItem = {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};

function isTextItem(value: unknown): value is PdfJsTextItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string"
  );
}

function itemRect(item: PdfJsTextItem): PdfRect {
  const x = item.transform[4];
  const baseline = item.transform[5];
  const height = Math.max(item.height, Math.hypot(item.transform[2], item.transform[3]));
  const pad = Math.max(0.5, height * 0.12);
  return {
    x0: Math.min(x, x + item.width) - pad,
    y0: baseline - height * 0.22 - pad,
    x1: Math.max(x, x + item.width) + pad,
    y1: baseline + height * 0.9 + pad,
  };
}

export async function extractPageText(
  document: PDFDocumentProxy,
  pageIndex: number,
): Promise<PageTextMap> {
  const page = await document.getPage(pageIndex + 1);
  const content = await page.getTextContent();
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
      rect: itemRect(rawItem),
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
  const length = Math.max(1, segment.end - segment.start);
  const startFraction = (start - segment.start) / length;
  const endFraction = (end - segment.start) / length;
  const width = segment.rect.x1 - segment.rect.x0;
  const from = segment.dir === "rtl" ? 1 - endFraction : startFraction;
  const to = segment.dir === "rtl" ? 1 - startFraction : endFraction;
  return {
    ...segment.rect,
    x0: segment.rect.x0 + width * Math.max(0, from),
    x1: segment.rect.x0 + width * Math.min(1, to),
  };
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
