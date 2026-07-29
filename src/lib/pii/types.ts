import type { PdfRect } from "@/lib/pdf/types";

export type PiiSource = "recognizer" | "model";

export type PiiFinding = {
  start: number;
  end: number;
  category: string;
  confidence: number;
  source: PiiSource;
};

export type PageTextSegment = {
  start: number;
  end: number;
  text: string;
  dir: string;
  rect: PdfRect;
};

export type PageTextMap = {
  pageIndex: number;
  text: string;
  segments: PageTextSegment[];
};

export type PiiScanResult = {
  findings: PiiFinding[];
  modelAvailable: boolean;
  modelError?: string;
};
