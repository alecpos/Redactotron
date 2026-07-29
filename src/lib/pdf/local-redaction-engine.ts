import type { PdfRect, RedactionBlock } from "@/lib/pdf/types";

const REPLACEMENT = "REDACTED";
const LARGE_IMAGE_PIXELS = 750_000;
const SCAN_JPEG_QUALITY = 92;
const SAVE_OPTIONS = {
  clean: true,
  sanitize: true,
  garbage: "deduplicate",
  compress: true,
  "compress-fonts": true,
  "compress-images": true,
  objstms: true,
  encrypt: "none",
  "regenerate-id": true,
};

type MuPdfModule = typeof import("mupdf");
type MuPdfApi = MuPdfModule["default"];
type MuPdfDocument = InstanceType<MuPdfModule["PDFDocument"]>;
type MuPdfPage = InstanceType<MuPdfModule["PDFPage"]>;

function normalizedRect(rect: PdfRect): [number, number, number, number] {
  return [
    Math.min(rect.x0, rect.x1),
    Math.min(rect.y0, rect.y1),
    Math.max(rect.x0, rect.x1),
    Math.max(rect.y0, rect.y1),
  ];
}

function intersectionArea(
  left: [number, number, number, number],
  right: [number, number, number, number],
) {
  const width = Math.max(
    0,
    Math.min(left[2], right[2]) - Math.max(left[0], right[0]),
  );
  const height = Math.max(
    0,
    Math.min(left[3], right[3]) - Math.max(left[1], right[1]),
  );
  return width * height;
}

function validateRect(
  rect: PdfRect,
  pageBounds: [number, number, number, number],
) {
  const normalized = normalizedRect(rect);
  if (
    !normalized.every(Number.isFinite) ||
    normalized[2] - normalized[0] <= 0 ||
    normalized[3] - normalized[1] <= 0
  ) {
    throw new Error("A redaction rectangle is invalid.");
  }
  if (intersectionArea(normalized, pageBounds) <= 0) {
    throw new Error("A redaction rectangle is outside its page.");
  }
  return normalized;
}

function pdfNumber(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error("A redaction coordinate is invalid.");
  }
  const normalized = Math.abs(value) < 0.000_001 ? 0 : value;
  return Number(normalized.toFixed(4)).toString();
}

function glyphWidth(font: InstanceType<MuPdfModule["Font"]>, value: string) {
  let width = 0;
  for (const character of value) {
    const glyph = font.encodeCharacter(character);
    width += font.advanceGlyph(glyph);
  }
  return Math.max(width, 0.001);
}

function uniqueFontResourceName(
  fonts: InstanceType<MuPdfModule["PDFObject"]>,
) {
  let index = 1;
  while (!fonts.get(`Redactotron${index}`).isNull()) index += 1;
  return `Redactotron${index}`;
}

function appendOverlayStream(
  mupdf: MuPdfApi,
  document: MuPdfDocument,
  page: MuPdfPage,
  blocks: RedactionBlock[],
  font: InstanceType<MuPdfModule["Font"]>,
  fontReference: InstanceType<MuPdfModule["PDFObject"]>,
) {
  const pageObject = page.getObject();
  let resources = pageObject.get("Resources");
  if (!resources.isDictionary()) {
    resources = pageObject.getInheritable("Resources");
  }
  if (!resources.isDictionary()) {
    resources = document.newDictionary();
    pageObject.put("Resources", resources);
  }

  let fonts = resources.get("Font");
  if (!fonts.isDictionary()) {
    fonts = document.newDictionary();
    resources.put("Font", fonts);
  }
  const fontName = uniqueFontResourceName(fonts);
  fonts.put(fontName, fontReference);

  const commands: string[] = ["q", "1 g"];
  for (const block of blocks) {
    for (const sourceRect of block.rects) {
      const [x0, y0, x1, y1] = normalizedRect(sourceRect);
      commands.push(
        `${pdfNumber(x0)} ${pdfNumber(y0)} ${pdfNumber(x1 - x0)} ${pdfNumber(y1 - y0)} re f`,
      );
    }
  }
  commands.push("Q", "0 g");

  const replacementWidth = glyphWidth(font, REPLACEMENT);
  for (const block of blocks) {
    const labelRect =
      block.rects[block.labelRectIndex] ?? block.rects[0];
    const [x0, y0, x1, y1] = normalizedRect(labelRect);
    const width = x1 - x0;
    const height = y1 - y0;
    const heightSize = height * 0.72;
    const widthSize = Math.max(0.5, width - 2) / replacementWidth;
    const requestedSize = block.sourceFontSize ?? heightSize;
    const fontSize = Math.max(
      0.5,
      Math.min(requestedSize, heightSize, widthSize),
    );
    const textWidth = replacementWidth * fontSize;
    const textX = x0 + Math.max(1, (width - textWidth) / 2);
    const textY = y0 + Math.max(0, (height - fontSize) / 2) + fontSize * 0.16;
    commands.push(
      `BT /${fontName} ${pdfNumber(fontSize)} Tf 1 0 0 1 ${pdfNumber(textX)} ${pdfNumber(textY)} Tm (${REPLACEMENT}) Tj ET`,
    );
  }

  const overlay = document.addStream(`${commands.join("\n")}\n`, {});
  const contents = pageObject.get("Contents");
  if (contents.isArray()) {
    contents.push(overlay);
  } else if (contents.isNull()) {
    pageObject.put("Contents", overlay);
  } else {
    const sequence = document.newArray();
    sequence.push(contents);
    sequence.push(overlay);
    pageObject.put("Contents", sequence);
  }

  // Redaction annotations are no longer needed, and existing annotations,
  // widgets, links, or comments must not survive into the clean export.
  pageObject.delete("Annots");
}

function documentPageBounds(
  mupdf: MuPdfApi,
  page: MuPdfPage,
): [number, number, number, number] {
  return mupdf.Rect.transform(page.getBounds(), page.getTransform());
}

function recompressLargeRedactedImages(
  mupdf: MuPdfApi,
  document: MuPdfDocument,
  page: MuPdfPage,
) {
  const seen = new Set<number>();

  const visitResources = (
    resources: InstanceType<MuPdfModule["PDFObject"]>,
  ) => {
    const xObjects = resources.get("XObject");
    if (!xObjects.isDictionary()) return;

    xObjects.forEach((reference, name) => {
      const objectNumber = reference.isIndirect()
        ? reference.asIndirect()
        : null;
      if (objectNumber !== null) {
        if (seen.has(objectNumber)) return;
        seen.add(objectNumber);
      }

      const object = reference.resolve();
      const subtype = object.get("Subtype");
      if (!subtype.isName()) return;

      if (subtype.asName() === "Form") {
        const formResources = object.get("Resources");
        if (formResources.isDictionary()) visitResources(formResources);
        return;
      }
      if (subtype.asName() !== "Image") return;

      const filter = object.get("Filter");
      const width = object.get("Width").asNumber();
      const height = object.get("Height").asNumber();
      if (
        !filter.isName() ||
        filter.asName() !== "FlateDecode" ||
        !object.get("SMask").isNull() ||
        !object.get("Mask").isNull() ||
        width * height < LARGE_IMAGE_PIXELS
      ) {
        return;
      }

      const rawStream = reference.readRawStream();
      const rawLength = rawStream.getLength();
      rawStream.destroy();

      const image = document.loadImage(reference);
      const sourcePixmap = image.toPixmap();
      let compressionPixmap = sourcePixmap;
      let converted: InstanceType<MuPdfModule["Pixmap"]> | null = null;
      try {
        if (sourcePixmap.getAlpha()) return;
        const colorSpace = sourcePixmap.getColorSpace();
        if (!colorSpace?.isGray() && !colorSpace?.isRGB()) {
          converted = sourcePixmap.convertToColorSpace(
            mupdf.ColorSpace.DeviceRGB,
            false,
          );
          compressionPixmap = converted;
        }

        const jpeg = compressionPixmap.asJPEG(SCAN_JPEG_QUALITY);
        if (jpeg.byteLength >= rawLength) return;

        const replacementImage = new mupdf.Image(jpeg);
        try {
          xObjects.put(name, document.addImage(replacementImage));
        } finally {
          replacementImage.destroy();
        }
      } finally {
        converted?.destroy();
        sourcePixmap.destroy();
        image.destroy();
      }
    });
  };

  const resources = page.getObject().getInheritable("Resources");
  if (resources.isDictionary()) visitResources(resources);
}

export async function createLocalRedactedPdf(
  source: ArrayBuffer | Uint8Array,
  blocks: RedactionBlock[],
) {
  if (!blocks.length) {
    throw new Error("At least one redaction is required.");
  }

  if (typeof location !== "undefined" && location.origin) {
    globalThis.$libmupdf_wasm_Module = {
      locateFile: () =>
        new URL("/runtime/mupdf-wasm.wasm", location.origin).href,
    };
  }
  const mupdfModule = await import("mupdf");
  const mupdf = mupdfModule.default;
  const bytes =
    source instanceof Uint8Array ? source : new Uint8Array(source);
  const sourceDocument = new mupdf.PDFDocument(bytes);
  let materializedDocument: MuPdfDocument | null = null;
  let cleanDocument: MuPdfDocument | null = null;

  try {
    if (sourceDocument.needsPassword()) {
      throw new Error("Password-protected PDFs are not supported.");
    }
    sourceDocument.disableJS();

    const pageCount = sourceDocument.countPages();
    const pageBlocks = new Map<number, RedactionBlock[]>();
    for (const block of blocks) {
      if (block.pageIndex < 0 || block.pageIndex >= pageCount) {
        throw new Error("A redaction refers to a missing page.");
      }
      const current = pageBlocks.get(block.pageIndex) ?? [];
      current.push(block);
      pageBlocks.set(block.pageIndex, current);
    }

    const replacementFont = new mupdf.Font("Helvetica");
    const replacementFontReference = sourceDocument.addSimpleFont(
      replacementFont,
      "Latin",
    );

    for (const [pageIndex, blocksForPage] of pageBlocks) {
      const page = sourceDocument.loadPage(pageIndex);
      try {
        const pageBounds = documentPageBounds(mupdf, page);
        const pageToPdf = page.getTransform();
        const pdfToPage = mupdf.Matrix.invert(pageToPdf);

        for (const block of blocksForPage) {
          for (const sourceRect of block.rects) {
            const pdfRect = validateRect(sourceRect, pageBounds);
            const annotationRect = mupdf.Rect.transform(pdfRect, pdfToPage);
            const annotation = page.createAnnotation("Redact");
            annotation.setRect(annotationRect);
            annotation.update();
          }
        }

        page.applyRedactions(
          false,
          mupdf.PDFPage.REDACT_IMAGE_PIXELS,
          mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
          mupdf.PDFPage.REDACT_TEXT_REMOVE,
        );
        page.update();
        appendOverlayStream(
          mupdf,
          sourceDocument,
          page,
          blocksForPage,
          replacementFont,
          replacementFontReference,
        );
        page.update();
      } finally {
        page.destroy();
      }
    }

    const materializedBuffer = sourceDocument.saveToBuffer(SAVE_OPTIONS);
    try {
      materializedDocument = new mupdf.PDFDocument(
        new Uint8Array(materializedBuffer.asUint8Array()),
      );
    } finally {
      materializedBuffer.destroy();
    }

    for (const pageIndex of pageBlocks.keys()) {
      const page = materializedDocument.loadPage(pageIndex);
      try {
        recompressLargeRedactedImages(mupdf, materializedDocument, page);
        page.update();
      } finally {
        page.destroy();
      }
    }

    cleanDocument = new mupdf.PDFDocument();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      cleanDocument.graftPage(-1, materializedDocument, pageIndex);
    }

    const outputBuffer = cleanDocument.saveToBuffer(SAVE_OPTIONS);
    try {
      return new Uint8Array(outputBuffer.asUint8Array());
    } finally {
      outputBuffer.destroy();
    }
  } finally {
    cleanDocument?.destroy();
    materializedDocument?.destroy();
    sourceDocument.destroy();
  }
}
