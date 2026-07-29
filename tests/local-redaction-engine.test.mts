import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import mupdf from "mupdf";
import { createLocalRedactedPdf } from "../src/lib/pdf/local-redaction-engine.ts";
import type { RedactionBlock } from "../src/lib/pdf/types.ts";

async function makeVectorFixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const secret = "SYNTHETIC SECRET";
  const publicText = "PUBLIC SEARCHABLE TEXT";
  const fontSize = 16;
  const x = 72;
  const secretY = 700;

  page.drawText(secret, {
    x,
    y: secretY,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });
  page.drawText(publicText, {
    x,
    y: 650,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });
  document.setAuthor("Synthetic Person");
  document.setTitle("Synthetic confidential fixture");

  const secretWidth = font.widthOfTextAtSize(secret, fontSize);
  const block: RedactionBlock = {
    id: "synthetic-secret",
    pageIndex: 0,
    rects: [
      {
        x0: x - 2,
        y0: secretY - 3,
        x1: x + secretWidth + 2,
        y1: secretY + fontSize + 3,
      },
    ],
    labelRectIndex: 0,
    sourceFontSize: fontSize,
    replacement: "REDACTED",
    appearance: "text-replacement",
  };

  return {
    bytes: new Uint8Array(await document.save()),
    block,
    secret,
    publicText,
  };
}

async function makeScannedFixture() {
  const width = 1_200;
  const height = 1_600;
  const pixmap = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [0, 0, width, height],
    false,
  );
  pixmap.clear(255);
  const pixels = pixmap.getPixels();
  for (let y = 120; y < 180; y += 1) {
    for (let x = 120; x < 700; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 20;
      pixels[offset + 1] = 20;
      pixels[offset + 2] = 20;
    }
  }
  const jpeg = pixmap.asJPEG(92);
  pixmap.destroy();

  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const image = await document.embedJpg(jpeg);
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 800 });

  const block: RedactionBlock = {
    id: "synthetic-scan-area",
    pageIndex: 0,
    rects: [{ x0: 55, y0: 700, x1: 365, y1: 750 }],
    labelRectIndex: 0,
    replacement: "REDACTED",
    appearance: "area-replacement",
  };

  return {
    bytes: new Uint8Array(await document.save()),
    block,
  };
}

test("browser engine destroys selected text while preserving vector text", async () => {
  const fixture = await makeVectorFixture();
  const output = await createLocalRedactedPdf(fixture.bytes, [fixture.block]);
  const result = new mupdf.PDFDocument(output);

  try {
    assert.ok(
      output.byteLength <= fixture.bytes.byteLength * 2,
      `vector export grew unexpectedly: ${fixture.bytes.byteLength} -> ${output.byteLength} bytes`,
    );
    assert.equal(result.countPages(), 1);
    assert.equal(result.getMetaData(mupdf.Document.META_INFO_AUTHOR), undefined);
    assert.deepEqual(Object.keys(result.getEmbeddedFiles()), []);

    const page = result.loadPage(0);
    try {
      const text = page.toStructuredText().asText();
      assert.equal(text.includes(fixture.secret), false);
      assert.equal(text.includes(fixture.publicText), true);
      assert.equal(text.match(/REDACTED/g)?.length, 1);
      assert.equal(page.getAnnotations().length, 0);
      assert.equal(page.getWidgets().length, 0);
      assert.equal(page.getLinks().length, 0);

      const pageObject = page.getObject();
      assert.equal(pageObject.get("Contents").isNull(), false);
      assert.equal(
        pageObject.getInheritable("Resources").get("XObject").isNull(),
        true,
      );
    } finally {
      page.destroy();
    }
  } finally {
    result.destroy();
  }
});

test("browser engine keeps a redacted scan compact", async () => {
  const fixture = await makeScannedFixture();
  const output = await createLocalRedactedPdf(fixture.bytes, [fixture.block]);
  const result = new mupdf.PDFDocument(output);

  try {
    assert.ok(
      output.byteLength <= fixture.bytes.byteLength * 1.2,
      `scan export grew unexpectedly: ${fixture.bytes.byteLength} -> ${output.byteLength} bytes`,
    );
    const page = result.loadPage(0);
    try {
      assert.match(page.toStructuredText().asText(), /REDACTED/);
      assert.equal(
        page.getObject().getInheritable("Resources").get("XObject").isNull(),
        false,
      );
    } finally {
      page.destroy();
    }
  } finally {
    result.destroy();
  }
});
