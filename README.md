# Redactotron

A focused, browser-only document redaction editor built with Next.js, PDF.js,
PDF-Lib, MuPDF WebAssembly, Mammoth, Tesseract.js, and Transformers.js. Users
can import PDF, DOCX, TXT, PNG, or JPEG files; select text or draw a section;
review and remove draft blocks; then export a searchable PDF in which the
selected content is physically removed and replaced with `REDACTED`.

The editor can also suggest sensitive data with a hybrid detector. Email
addresses, US SSNs, phone numbers, payment cards, IBANs, and context-labeled
account numbers use deterministic validation. Names and locations use a
quantized BERT token-classification model through Transformers.js. Inference
runs in the browser; suggestions remain removable drafts until the user
confirms the export.

## Run locally

Install the JavaScript dependencies:

```bash
npm install
```

Start Next.js:

```bash
npm run dev
```

Open `http://localhost:3000`.

Run checks:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:pii
npm run test:local-redaction
```

The pinned 28.7 MB INT8 model, ONNX runtime, MuPDF WebAssembly engine,
Tesseract worker/core, and English OCR data are served from the same origin as
the application. Transformers.js is configured with remote model loading
disabled. The build verifies SHA-256 hashes for the committed model and OCR
assets.

After the application and its static assets have loaded, importing, OCR,
sensitive-data detection, redaction, verification, and PDF export all happen
inside the browser. No document bytes, pixels, extracted text, selections, or
redaction coordinates are sent to an application server or third-party
service. A `connect-src 'self'` Content Security Policy provides an additional
browser-enforced boundary.

The model is English-focused and its output is advisory: evaluate it against
representative documents before broadening entity types or lowering confidence
thresholds.

## How the redaction works

Every supported source is normalized in the browser into a working PDF:

- PDF files are inspected page-by-page. Existing searchable text is preserved;
  image-only pages are rendered and receive a positioned, invisible English OCR
  text layer locally in the browser.
- DOCX files are converted into structured, searchable text with headings,
  paragraphs, lists, and table rows. Complex Word layout and embedded images
  are not preserved in the current importer.
- TXT files are typeset into a searchable PDF.
- PNG and JPEG files retain their source image and receive a positioned,
  invisible English OCR text layer. The locally served OCR engine and English
  language data run in the browser; document pixels are not sent to an OCR
  service.

The original source file is retained only for its name and never overwritten.
PDF.js renders the working PDF and exposes its selectable text layer. Each
pointer action becomes one logical block containing one or more line
rectangles. Coordinates are saved in PDF user space, not screen pixels.

On Apply, the browser-local MuPDF WebAssembly engine:

1. validates the PDF and every coordinate;
2. converts PDF.js coordinates into MuPDF page space;
3. adds redaction annotations and applies them to text, images, and graphics;
4. inserts one searchable `REDACTED` label per logical block;
5. grafts only the sanitized pages into a new PDF, excluding document metadata,
   scripts, attachments, forms, links, comments, and unrelated objects;
6. garbage-collects, sanitizes, deduplicates, and compresses the output.

The original file is never overwritten, no server endpoint receives the PDF,
and every output is a vector-preserving PDF. Images are modified only where a
redaction intersects their pixels, so pages are not rasterized and output size
does not balloon from full-page screenshots. Large modified scan images are
recompressed as high-quality JPEG only when that makes the exported PDF
smaller; native vector content is never converted to pixels.

## Production notes

- Browser OCR currently uses English recognition. Add an explicit language
  picker and vendor the corresponding trained-data files before claiming
  multilingual OCR support.
- DOCX import prioritizes searchable, reviewable content over Word layout
  fidelity. A layout-faithful conversion service would conflict with the
  browser-only privacy boundary.
- MuPDF is offered under AGPL and commercial licenses. A public deployment
  must satisfy the AGPL's source and distribution requirements or use an
  Artifex commercial license; confirm the intended licensing path before
  production use.
- The vector-preserving mode retains legitimate text outside marked regions.
  Signed PDFs lose their signature validity when edited, and encrypted PDFs are
  rejected rather than risking a misleading output.

## Primary references

- [Adobe: redact and sanitize PDFs](https://helpx.adobe.com/acrobat/desktop/protect-documents/redact-pdfs/redacting-sanitizing.html)
- [MuPDF JavaScript redaction APIs](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html#PDFPage.prototype.applyRedactions)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
- [ONNX Runtime Web browser inference](https://onnxruntime.ai/docs/tutorials/web/)
- [Transformers.js pipelines](https://huggingface.co/docs/transformers.js/pipelines)
- [BERT small PII detector model card](https://huggingface.co/onnx-community/bert-small-pii-detection-ONNX)
- [PDF-Lib](https://github.com/Hopding/pdf-lib)
- [Mammoth browser API](https://github.com/mwilliamson/mammoth.js)
- [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)
- [PETS 2023: Glyph positions break PDF text redaction](https://petsymposium.org/popets/2023/popets-2023-0069.php)
