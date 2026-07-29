export type PdfRect = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type RedactionBlock = {
  id: string;
  pageIndex: number;
  rects: PdfRect[];
  labelRectIndex: number;
  sourceFontSize: number | null;
  replacement: "REDACTED";
  appearance: "text-replacement";
  suggestion?: {
    category: string;
    confidence: number;
    source: "recognizer" | "model";
  };
};

export type ToolMode = "text" | "area";

export type DraftArea = {
  pageIndex: number;
  rect: PdfRect;
};
