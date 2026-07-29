# Redactotron

A focused PDF redaction editor built with Next.js, PDF.js, Flask, and
PyMuPDF. Users can select text or draw a section, review and remove draft
blocks, then export a new PDF in which the original content is physically
removed and replaced with searchable `REDACTED` text.

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
source .venv/bin/activate && npm run test:engine
```

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
- [Vercel Python runtime](https://vercel.com/docs/functions/runtimes/python)
- [Vercel request size and direct-upload guidance](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [PETS 2023: Glyph positions break PDF text redaction](https://petsymposium.org/popets/2023/popets-2023-0069.php)
