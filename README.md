# Redactotron

A focused PDF redaction editor built with Next.js, PDF.js, Flask, and
PyMuPDF. Users can select text or draw a section, review and remove draft
blocks, then export a new PDF in which the original content is physically
removed and replaced with searchable `REDACTED` text.

The editor can also suggest sensitive data with a hybrid detector. Email
addresses, US SSNs, phone numbers, payment cards, IBANs, and context-labeled
account numbers use deterministic validation. Names and locations use a
quantized BERT token-classification model through Transformers.js. Inference
runs in the browser; suggestions remain removable drafts until the user
confirms the export.

## Run locally

Install the JavaScript and Python dependencies:

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Start Next.js and the local Python redaction service together:

```bash
npm run dev
```

Open `http://localhost:3000`. In development, Next.js proxies
`/api/redact` to the local Flask process. On Vercel, `api/redact.py` is
served directly as the Python Function at that path.

Run checks:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:pii
source .venv/bin/activate && npm run test:engine
```

The first sensitive-data scan downloads the pinned 28.7 MB INT8 model into
the browser cache. No PDF text is sent to an inference service. The model is
English-focused and its output is advisory: evaluate it against representative
documents before broadening entity types or lowering confidence thresholds.

## How the redaction works

The browser uses PDF.js for rendering and its selectable text layer. Each
pointer action becomes one logical block containing one or more line
rectangles. Coordinates are saved in PDF user space, not screen pixels.

On Apply, `/api/redact.py`:

1. validates the PDF and every coordinate;
2. converts PDF.js coordinates with PyMuPDF's page transformation matrix;
3. adds redaction annotations and applies them to text, images, and graphics;
4. inserts one searchable `REDACTED` label per logical block;
5. removes metadata, scripts, attachments, links, thumbnails, comments, and
   unreferenced objects;
6. reopens the output and verifies both content removal and replacement text.

The original file is never overwritten.

## Production notes

- The direct request is intentionally limited to 4 MB because Vercel
  Functions have a 4.5 MB request body limit. For larger PDFs, upload directly
  to Vercel Private Blob and send only the private pathname, hash, and manifest
  to the Python function.
- PyMuPDF is offered under AGPL and commercial licenses. A closed-source SaaS
  should obtain an Artifex commercial license or use a commercial PDF SDK.
- The ATS-preserving mode retains legitimate text outside marked regions.
  For especially sensitive material, add a high-assurance export that
  rasterizes the already-redacted pages into a new PDF and OCRs that result.
- Signed, encrypted, and active-form PDFs are rejected in this first version
  rather than risking a misleading or invalid output.

## Primary references

- [Adobe: redact and sanitize PDFs](https://helpx.adobe.com/acrobat/desktop/protect-documents/redact-pdfs/redacting-sanitizing.html)
- [PyMuPDF redaction APIs](https://pymupdf.readthedocs.io/en/latest/page.html)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
- [ONNX Runtime Web browser inference](https://onnxruntime.ai/docs/tutorials/web/)
- [Transformers.js pipelines](https://huggingface.co/docs/transformers.js/pipelines)
- [BERT small PII detector model card](https://huggingface.co/onnx-community/bert-small-pii-detection-ONNX)
- [Vercel Python runtime](https://vercel.com/docs/functions/runtimes/python)
- [Vercel request size and direct-upload guidance](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [PETS 2023: Glyph positions break PDF text redaction](https://petsymposium.org/popets/2023/popets-2023-0069.php)
