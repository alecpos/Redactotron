import type {
  PDFFont,
  PDFPage,
} from "pdf-lib";

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const PAGE_MARGIN = 54;
const MAX_PAGES = 100;
const MAX_TEXT_CHARACTERS = 500_000;
const MAX_OCR_WORDS = 10_000;
const MIN_SEARCHABLE_CHARACTERS = 16;
const MAX_OCR_RENDER_PIXELS = 4_000_000;
const MAX_OCR_RENDER_DIMENSION = 2_400;

export const SUPPORTED_DOCUMENT_LABEL =
  "PDF, DOCX, TXT, PNG, or JPEG";

export type DocumentKind = "pdf" | "docx" | "text" | "image";

export type ImportProgress = {
  message: string;
  progress?: number;
};

export type ImportedDocument = {
  kind: DocumentKind;
  pdfFile: File;
  notice: string | null;
};

type ProgressCallback = (progress: ImportProgress) => void;

function localOcrOptions(logger: (message: Tesseract.LoggerMessage) => void) {
  return {
    corePath: "/tesseract/core",
    langPath: "/tesseract/lang",
    workerPath: "/tesseract/worker.min.js",
    workerBlobURL: true,
    gzip: true,
    legacyCore: false,
    legacyLang: false,
    logger,
  } satisfies Partial<Tesseract.WorkerOptions>;
}

type TextBlock = {
  kind: "title" | "heading" | "body" | "list" | "table" | "space";
  text: string;
};

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function outputPdfName(name: string) {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return `${stem || "document"}-working.pdf`;
}

function startsWithBytes(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

async function detectDocumentKind(file: File): Promise<DocumentKind> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const extension = extensionOf(file.name);

  if (
    header.length >= 5 &&
    new TextDecoder("ascii").decode(header.slice(0, 5)) === "%PDF-"
  ) {
    return "pdf";
  }
  if (
    startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWithBytes(header, [0xff, 0xd8, 0xff])
  ) {
    return "image";
  }
  if (
    extension === "docx" ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (!startsWithBytes(header, [0x50, 0x4b])) {
      throw new Error("That Word document is malformed or unsupported.");
    }
    return "docx";
  }
  if (
    extension === "txt" ||
    file.type === "text/plain" ||
    file.type.startsWith("text/")
  ) {
    return "text";
  }

  throw new Error(
    `Unsupported document type. Choose ${SUPPORTED_DOCUMENT_LABEL}.`,
  );
}

function commonCharacterFallback(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/[•◦▪]/g, "*")
    .replace(/\u00a0/g, " ");
}

function encodeableText(value: string, font: PDFFont) {
  const normalized = commonCharacterFallback(value);
  let result = "";

  for (const character of normalized) {
    if (character === "\t") {
      result += "    ";
      continue;
    }
    try {
      font.encodeText(character);
      result += character;
    } catch {
      result += "?";
    }
  }
  return result;
}

function splitLongToken(
  token: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
) {
  const pieces: string[] = [];
  let current = "";

  for (const character of token) {
    const candidate = current + character;
    if (
      current &&
      font.widthOfTextAtSize(candidate, fontSize) > maxWidth
    ) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function wrapText(
  value: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
) {
  const safe = encodeableText(value, font).trim();
  if (!safe) return [];

  const tokens = safe.split(/\s+/).flatMap((token) =>
    font.widthOfTextAtSize(token, fontSize) <= maxWidth
      ? [token]
      : splitLongToken(token, font, fontSize, maxWidth),
  );
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (
      current &&
      font.widthOfTextAtSize(candidate, fontSize) > maxWidth
    ) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function textStyle(block: TextBlock) {
  switch (block.kind) {
    case "title":
      return { fontSize: 20, lineHeight: 25, before: 8, after: 10, bold: true };
    case "heading":
      return { fontSize: 14, lineHeight: 18, before: 9, after: 5, bold: true };
    case "list":
      return { fontSize: 10.5, lineHeight: 14, before: 1, after: 3, bold: false };
    case "table":
      return { fontSize: 9.5, lineHeight: 13, before: 2, after: 4, bold: false };
    case "space":
      return { fontSize: 10.5, lineHeight: 14, before: 0, after: 9, bold: false };
    default:
      return { fontSize: 10.5, lineHeight: 14, before: 1, after: 6, bold: false };
  }
}

async function createSearchableTextPdf(
  blocks: TextBlock[],
  sourceName: string,
) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = LETTER_WIDTH - PAGE_MARGIN * 2;
  let page = pdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
  let y = LETTER_HEIGHT - PAGE_MARGIN;

  const nextPage = () => {
    if (pdf.getPageCount() >= MAX_PAGES) {
      throw new Error(`Imported documents are limited to ${MAX_PAGES} pages.`);
    }
    page = pdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
    y = LETTER_HEIGHT - PAGE_MARGIN;
  };

  for (const block of blocks) {
    const style = textStyle(block);
    if (block.kind === "space") {
      y -= style.after;
      continue;
    }

    const font = style.bold ? bold : regular;
    const prefix = block.kind === "list" ? "* " : "";
    const lines = wrapText(
      `${prefix}${block.text}`,
      font,
      style.fontSize,
      contentWidth,
    );
    if (!lines.length) {
      y -= style.after;
      continue;
    }

    const requiredHeight =
      style.before + lines.length * style.lineHeight + style.after;
    if (y - requiredHeight < PAGE_MARGIN) nextPage();
    y -= style.before;

    for (const line of lines) {
      page.drawText(line, {
        x: PAGE_MARGIN,
        y: y - style.fontSize,
        size: style.fontSize,
        font,
        color: rgb(0.08, 0.09, 0.09),
      });
      y -= style.lineHeight;
    }
    y -= style.after;
  }

  pdf.setTitle(sourceName);
  pdf.setCreator("Redactotron");
  pdf.setProducer("Redactotron searchable import");
  const bytes = await pdf.save({ useObjectStreams: true });
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function directText(element: Element) {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function docxHtmlToBlocks(html: string): TextBlock[] {
  const parsed = new DOMParser().parseFromString(
    `<main>${html}</main>`,
    "text/html",
  );
  const root = parsed.querySelector("main");
  if (!root) return [];

  const blocks: TextBlock[] = [];
  const visit = (element: Element) => {
    const tag = element.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = directText(element);
      if (text) {
        blocks.push({
          kind: tag === "h1" ? "title" : "heading",
          text,
        });
      }
      return;
    }
    if (tag === "p") {
      const text = directText(element);
      blocks.push(text ? { kind: "body", text } : { kind: "space", text: "" });
      return;
    }
    if (tag === "li") {
      const text = directText(element);
      if (text) blocks.push({ kind: "list", text });
      return;
    }
    if (tag === "table") {
      for (const row of Array.from(element.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"))
          .map(directText)
          .filter(Boolean);
        if (cells.length) {
          blocks.push({ kind: "table", text: cells.join(" | ") });
        }
      }
      blocks.push({ kind: "space", text: "" });
      return;
    }
    if (tag === "img") {
      blocks.push({
        kind: "body",
        text: "[Embedded image omitted from searchable Word import]",
      });
      return;
    }

    for (const child of Array.from(element.children)) visit(child);
  };

  for (const child of Array.from(root.children)) visit(child);
  return blocks;
}

async function importDocx(file: File, onProgress: ProgressCallback) {
  onProgress({ message: "Reading Word document…" });
  const mammothModule = await import("mammoth");
  const mammoth = mammothModule.default;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    {
      externalFileAccess: false,
      includeDefaultStyleMap: true,
      ignoreEmptyParagraphs: false,
    },
  );
  const blocks = docxHtmlToBlocks(result.value);
  const characterCount = blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  );
  if (!characterCount) {
    throw new Error("No readable text was found in that Word document.");
  }
  if (characterCount > MAX_TEXT_CHARACTERS) {
    throw new Error("That Word document contains too much text for this version.");
  }

  onProgress({ message: "Creating searchable PDF…" });
  const bytes = await createSearchableTextPdf(blocks, file.name);
  return {
    bytes,
    notice:
      "Word content was normalized into a searchable PDF. Complex layout and embedded images are not preserved in this version.",
  };
}

function textToBlocks(text: string): TextBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized.split(/\n{2,}/).flatMap((paragraph, index) => {
    const lines = paragraph.split("\n");
    const blocks: TextBlock[] = lines.map((line) => ({
      kind: line.trim() ? "body" : "space",
      text: line.trim(),
    }));
    if (index > 0) blocks.unshift({ kind: "space", text: "" });
    return blocks;
  });
}

async function importText(file: File, onProgress: ProgressCallback) {
  onProgress({ message: "Reading text document…" });
  const text = await file.text();
  if (!text.trim()) throw new Error("That text document is empty.");
  if (text.length > MAX_TEXT_CHARACTERS) {
    throw new Error("That text document contains too much text for this version.");
  }

  onProgress({ message: "Creating searchable PDF…" });
  return {
    bytes: await createSearchableTextPdf(textToBlocks(text), file.name),
    notice: "Text content was typeset into a searchable PDF for redaction.",
  };
}

function isOcrWord(value: unknown): value is Tesseract.Word {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    text?: unknown;
    confidence?: unknown;
    bbox?: {
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
    };
  };
  return (
    typeof candidate.text === "string" &&
    typeof candidate.confidence === "number" &&
    Number.isFinite(candidate.confidence) &&
    typeof candidate.bbox === "object" &&
    candidate.bbox !== null &&
    [
      candidate.bbox.x0,
      candidate.bbox.y0,
      candidate.bbox.x1,
      candidate.bbox.y1,
    ].every((coordinate) => (
      typeof coordinate === "number" && Number.isFinite(coordinate)
    ))
  );
}

export function flattenOcrWords(blocks: unknown): Tesseract.Word[] {
  if (!Array.isArray(blocks)) return [];

  const words: Tesseract.Word[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const paragraphs = (block as { paragraphs?: unknown }).paragraphs;
    if (!Array.isArray(paragraphs)) continue;

    for (const paragraph of paragraphs) {
      if (typeof paragraph !== "object" || paragraph === null) continue;
      const lines = (paragraph as { lines?: unknown }).lines;
      if (!Array.isArray(lines)) continue;

      for (const line of lines) {
        if (typeof line !== "object" || line === null) continue;
        const lineWords = (line as { words?: unknown }).words;
        if (!Array.isArray(lineWords)) continue;
        words.push(...lineWords.filter(isOcrWord));
      }
    }
  }
  return words;
}

function addInvisibleOcrWord(
  page: PDFPage,
  font: PDFFont,
  operators: PdfOperators,
  text: string,
  bbox: Tesseract.Bbox,
  toPdfPoint: (x: number, y: number) => number[],
) {
  const safeText = encodeableText(text, font).trim();
  if (!safeText) return;

  const {
    TextRenderingMode,
    beginText,
    endText,
    popGraphicsState,
    pushGraphicsState,
    setFontAndSize,
    setTextMatrix,
    setTextRenderingMode,
    showText,
  } = operators;
  const origin = toPdfPoint(bbox.x0, bbox.y1);
  const horizontalEnd = toPdfPoint(bbox.x1, bbox.y1);
  const verticalEnd = toPdfPoint(bbox.x0, bbox.y0);
  const horizontal = [
    horizontalEnd[0] - origin[0],
    horizontalEnd[1] - origin[1],
  ];
  const vertical = [
    verticalEnd[0] - origin[0],
    verticalEnd[1] - origin[1],
  ];
  const naturalWidth = Math.max(0.001, font.widthOfTextAtSize(safeText, 1));
  const naturalHeight = Math.max(
    0.001,
    font.heightAtSize(1, { descender: true }),
  );
  const fontKey = page.node.newFontDictionary("OCRText", font.ref);

  page.pushOperators(
    pushGraphicsState(),
    beginText(),
    setFontAndSize(fontKey, 1),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setTextMatrix(
      horizontal[0] / naturalWidth,
      horizontal[1] / naturalWidth,
      vertical[0] / naturalHeight,
      vertical[1] / naturalHeight,
      origin[0],
      origin[1],
    ),
    showText(font.encodeText(safeText)),
    endText(),
    popGraphicsState(),
  );
}

type PdfOperators = Pick<
  typeof import("pdf-lib"),
  | "TextRenderingMode"
  | "beginText"
  | "endText"
  | "popGraphicsState"
  | "pushGraphicsState"
  | "setFontAndSize"
  | "setTextMatrix"
  | "setTextRenderingMode"
  | "showText"
>;

function searchableCharacterCount(
  textContent: Awaited<
    ReturnType<
      import("pdfjs-dist/types/src/display/api").PDFPageProxy["getTextContent"]
    >
  >,
) {
  return textContent.items.reduce(
    (count, item) =>
      count + ("str" in item ? item.str.replace(/\s+/g, "").length : 0),
    0,
  );
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The scanned page could not be prepared for OCR."));
      }
    }, "image/png");
  });
}

function ocrRenderScale(width: number, height: number) {
  return Math.max(
    1,
    Math.min(
      2.5,
      MAX_OCR_RENDER_DIMENSION / Math.max(width, height),
      Math.sqrt(MAX_OCR_RENDER_PIXELS / (width * height)),
    ),
  );
}

async function importPdf(file: File, onProgress: ProgressCallback) {
  onProgress({ message: "Checking PDF text…" });
  const sourceBytes = await file.arrayBuffer();
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(sourceBytes.slice(0)),
  });
  const source = await loadingTask.promise;

  try {
    if (source.numPages > MAX_PAGES) {
      throw new Error(`PDFs are limited to ${MAX_PAGES} pages.`);
    }

    const scannedPageIndexes: number[] = [];
    for (let pageIndex = 0; pageIndex < source.numPages; pageIndex += 1) {
      onProgress({
        message: `Checking PDF text… page ${pageIndex + 1} of ${source.numPages}`,
      });
      const page = await source.getPage(pageIndex + 1);
      const textContent = await page.getTextContent();
      if (searchableCharacterCount(textContent) < MIN_SEARCHABLE_CHARACTERS) {
        scannedPageIndexes.push(pageIndex);
      }
      page.cleanup();
    }

    if (!scannedPageIndexes.length) {
      return { bytes: null, notice: null };
    }

    onProgress({
      message: `Preparing local OCR for ${scannedPageIndexes.length} scanned page${
        scannedPageIndexes.length === 1 ? "" : "s"
      }…`,
    });
    const [pdfLib, tesseract] = await Promise.all([
      import("pdf-lib"),
      import("tesseract.js"),
    ]);
    const pdf = await pdfLib.PDFDocument.load(sourceBytes);
    const font = await pdf.embedFont(pdfLib.StandardFonts.Helvetica);
    let activePageNumber = 1;
    const worker = await tesseract.createWorker(
      "eng",
      undefined,
      localOcrOptions((message) => {
        if (message.status === "recognizing text") {
          onProgress({
            message: `Reading scanned page ${activePageNumber} of ${
              scannedPageIndexes.length
            }… ${Math.round(message.progress * 100)}%`,
            progress: message.progress,
          });
        }
      }),
    );
    let pagesWithWords = 0;

    try {
      for (
        let scannedIndex = 0;
        scannedIndex < scannedPageIndexes.length;
        scannedIndex += 1
      ) {
        const pageIndex = scannedPageIndexes[scannedIndex];
        activePageNumber = scannedIndex + 1;
        onProgress({
          message: `Rendering scanned page ${activePageNumber} of ${scannedPageIndexes.length} locally…`,
        });
        const sourcePage = await source.getPage(pageIndex + 1);
        const baseViewport = sourcePage.getViewport({ scale: 1 });
        const viewport = sourcePage.getViewport({
          scale: ocrRenderScale(baseViewport.width, baseViewport.height),
        });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("Canvas rendering is unavailable for local OCR.");
        }

        await sourcePage.render({
          canvas,
          canvasContext: context,
          viewport,
        }).promise;
        const image = await canvasToBlob(canvas);
        const result = await worker.recognize(
          image,
          // Keep OCR coordinates in the rendered page coordinate system. Tesseract
          // still models sloped baselines, while disabling rotation prevents word
          // boxes from drifting away from the unchanged source-page pixels.
          { rotateAuto: false },
          { blocks: true, text: true },
        );
        const words = flattenOcrWords(result.data.blocks)
          .filter((word) => word.text.trim() && word.confidence >= 20)
          .slice(0, MAX_OCR_WORDS);
        const outputPage = pdf.getPage(pageIndex);
        for (const word of words) {
          addInvisibleOcrWord(
            outputPage,
            font,
            pdfLib,
            word.text,
            word.bbox,
            (x, y) => viewport.convertToPdfPoint(x, y),
          );
        }
        if (words.length) pagesWithWords += 1;

        sourcePage.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }
    } finally {
      await worker.terminate();
    }

    if (!pagesWithWords) {
      return {
        bytes: null,
        notice:
          "No English text was detected on the scanned PDF pages. Draw-area redaction is still available.",
      };
    }

    onProgress({ message: "Creating searchable PDF…" });
    pdf.setProducer("Redactotron browser OCR import");
    const output = await pdf.save({ useObjectStreams: true });
    return {
      bytes: output.buffer.slice(
        output.byteOffset,
        output.byteOffset + output.byteLength,
      ) as ArrayBuffer,
      notice:
        `Local English OCR added selectable word boxes to ${pagesWithWords} scanned page${
          pagesWithWords === 1 ? "" : "s"
        }. The document pixels never left your browser; review selections carefully.`,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function importImage(file: File, onProgress: ProgressCallback) {
  onProgress({ message: "Loading image…" });
  const pdfLib = await import("pdf-lib");
  const { PDFDocument, StandardFonts } = pdfLib;
  const pdf = await PDFDocument.create();
  const bytes = await file.arrayBuffer();
  const header = new Uint8Array(bytes.slice(0, 8));
  const isPng = startsWithBytes(header, [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const imageScale = Math.min(
    LETTER_WIDTH / image.width,
    LETTER_HEIGHT / image.height,
  );
  const pageWidth = image.width * imageScale;
  const pageHeight = image.height * imageScale;
  const page = pdf.addPage([pageWidth, pageHeight]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(
    "eng",
    undefined,
    localOcrOptions((message) => {
      if (message.status === "recognizing text") {
        onProgress({
          message: `Reading image text… ${Math.round(message.progress * 100)}%`,
          progress: message.progress,
        });
      }
    }),
  );

  try {
    const result = await worker.recognize(file, {}, {
      blocks: true,
      text: true,
    });
    const words = flattenOcrWords(result.data.blocks)
      .filter((word) => word.text.trim() && word.confidence >= 20)
      .slice(0, MAX_OCR_WORDS);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const word of words) {
      addInvisibleOcrWord(
        page,
        font,
        pdfLib,
        word.text,
        word.bbox,
        (x, y) => [x * imageScale, pageHeight - y * imageScale],
      );
    }

    onProgress({ message: "Creating searchable PDF…" });
    pdf.setTitle(file.name);
    pdf.setCreator("Redactotron");
    pdf.setProducer("Redactotron browser OCR import");
    const output = await pdf.save({ useObjectStreams: true });
    return {
      bytes: output.buffer.slice(
        output.byteOffset,
        output.byteOffset + output.byteLength,
      ) as ArrayBuffer,
      notice: words.length
        ? "English OCR text was added locally in your browser. Review selections carefully before applying redactions."
        : "No English text was detected. Draw-area redaction is available for this image.",
    };
  } finally {
    await worker.terminate();
  }
}

export async function importDocumentAsPdf(
  file: File,
  onProgress: ProgressCallback,
): Promise<ImportedDocument> {
  const kind = await detectDocumentKind(file);
  if (kind === "pdf") {
    const imported = await importPdf(file, onProgress);
    if (!imported.bytes) {
      return { kind, pdfFile: file, notice: imported.notice };
    }
    return {
      kind,
      pdfFile: new File([imported.bytes], outputPdfName(file.name), {
        type: "application/pdf",
        lastModified: file.lastModified,
      }),
      notice: imported.notice,
    };
  }

  const imported =
    kind === "docx"
      ? await importDocx(file, onProgress)
      : kind === "text"
        ? await importText(file, onProgress)
        : await importImage(file, onProgress);
  const pdfFile = new File([imported.bytes], outputPdfName(file.name), {
    type: "application/pdf",
    lastModified: file.lastModified,
  });
  return { kind, pdfFile, notice: imported.notice };
}
