"use client";

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  AreaIcon,
  CloseIcon,
  DownloadIcon,
  FileIcon,
  LockIcon,
  RedoIcon,
  ShieldIcon,
  TextSelectIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@/components/icons";
import Link from "next/link";
import { ApplyDialog } from "@/components/redactor/apply-dialog";
import { PdfPage } from "@/components/redactor/pdf-page";
import type {
  RedactionBlock,
  ToolMode,
} from "@/lib/pdf/types";
import { redactionManifestSchema } from "@/lib/pdf/redaction-schema";

const MAX_FILE_BYTES = 4_000_000;
const MAX_PAGES = 100;
const MAX_BLOCKS = 200;

type LoadState = "idle" | "loading" | "ready" | "error";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function outputFilename(name: string) {
  const withoutExtension = name.replace(/\.pdf$/i, "");
  return `${withoutExtension || "document"}-redacted.pdf`;
}

export function PdfRedactor() {
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<ToolMode>("text");
  const [scale, setScale] = useState(1);
  const [blocks, setBlocks] = useState<RedactionBlock[]>([]);
  const [past, setPast] = useState<RedactionBlock[][]>([]);
  const [future, setFuture] = useState<RedactionBlock[][]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [pageTextStatus, setPageTextStatus] = useState<
    Record<number, boolean>
  >({});

  const commitBlocks = useCallback(
    (next: RedactionBlock[]) => {
      setPast((history) => [...history.slice(-49), blocks]);
      setBlocks(next);
      setFuture([]);
    },
    [blocks],
  );

  const resetDocument = useCallback(async () => {
    await document?.loadingTask.destroy();
    setDocument(null);
    setFile(null);
    setBlocks([]);
    setPast([]);
    setFuture([]);
    setError(null);
    setNotice(null);
    setLoadState("idle");
    setSelectedBlockId(null);
    setPageTextStatus({});
  }, [document]);

  const loadFile = useCallback(
    async (nextFile: File) => {
      setError(null);
      setNotice(null);

      if (
        nextFile.type !== "application/pdf" &&
        !nextFile.name.toLowerCase().endsWith(".pdf")
      ) {
        setError("Choose a PDF file.");
        setLoadState("error");
        return;
      }
      if (nextFile.size > MAX_FILE_BYTES) {
        setError(
          `This Vercel-ready MVP accepts PDFs up to ${formatBytes(MAX_FILE_BYTES)}. Add Private Blob before raising the limit.`,
        );
        setLoadState("error");
        return;
      }

      const signature = await nextFile.slice(0, 5).text();
      if (signature !== "%PDF-") {
        setError("That file does not have a valid PDF signature.");
        setLoadState("error");
        return;
      }

      setLoadState("loading");
      try {
        await document?.loadingTask.destroy();
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const data = new Uint8Array(await nextFile.arrayBuffer());
        const task = pdfjs.getDocument({ data });
        const nextDocument = await task.promise;

        if (nextDocument.numPages > MAX_PAGES) {
          await nextDocument.loadingTask.destroy();
          throw new Error(`PDFs are limited to ${MAX_PAGES} pages.`);
        }

        setFile(nextFile);
        setDocument(nextDocument);
        setBlocks([]);
        setPast([]);
        setFuture([]);
        setScale(1);
        setMode("text");
        setSelectedBlockId(null);
        setPageTextStatus({});
        setLoadState("ready");
      } catch (caught) {
        setLoadState("error");
        setError(
          caught instanceof Error
            ? caught.message
            : "The PDF could not be opened.",
        );
      }
    },
    [document],
  );

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) void loadFile(nextFile);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    const nextFile = event.dataTransfer.files?.[0];
    if (nextFile) void loadFile(nextFile);
  };

  const addBlock = useCallback(
    (block: RedactionBlock) => {
      if (blocks.length >= MAX_BLOCKS) {
        setError(`A document can contain up to ${MAX_BLOCKS} redaction blocks.`);
        return;
      }
      commitBlocks([...blocks, block]);
      setSelectedBlockId(block.id);
      setNotice(null);
    },
    [blocks, commitBlocks],
  );

  const handleTextLayerStatus = useCallback(
    (pageIndex: number, hasText: boolean) => {
      setPageTextStatus((current) => {
        if (current[pageIndex] === hasText) return current;
        return { ...current, [pageIndex]: hasText };
      });

      if (pageIndex === 0 && !hasText) {
        setMode("area");
        setNotice(
          "No searchable text was detected. Draw area is active—drag a box over anything you want removed.",
        );
      }
    },
    [],
  );

  const removeBlock = useCallback(
    (id: string) => {
      commitBlocks(blocks.filter((block) => block.id !== id));
      setSelectedBlockId((selected) => (selected === id ? null : selected));
    },
    [blocks, commitBlocks],
  );

  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous) return;
    setFuture((history) => [blocks, ...history].slice(0, 50));
    setBlocks(previous);
    setPast((history) => history.slice(0, -1));
    setSelectedBlockId(null);
  }, [blocks, past]);

  const redo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    setPast((history) => [...history, blocks].slice(-50));
    setBlocks(next);
    setFuture((history) => history.slice(1));
    setSelectedBlockId(null);
  }, [blocks, future]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedBlockId &&
        !["INPUT", "TEXTAREA"].includes(
          (event.target as HTMLElement).tagName,
        )
      ) {
        event.preventDefault();
        removeBlock(selectedBlockId);
      }
      if (event.key === "Escape") {
        setSelectedBlockId(null);
        setShowApplyDialog(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, removeBlock, selectedBlockId, undo]);

  const applyRedactions = async () => {
    if (!file || !blocks.length) return;
    setProcessing(true);
    setError(null);
    setNotice(null);

    try {
      const manifest = redactionManifestSchema.parse({ blocks });
      const formData = new FormData();
      formData.append("file", file, file.name);
      formData.append("manifest", JSON.stringify(manifest));

      const response = await fetch("/api/redact", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response
          .json()
          .catch(() => null)) as { error?: string } | null;
        throw new Error(
          payload?.error || `Redaction failed (${response.status}).`,
        );
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = outputFilename(file.name);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);

      setShowApplyDialog(false);
      setNotice(
        `Secure copy created: ${outputFilename(file.name)}. Your original is unchanged.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The redacted PDF could not be created.",
      );
      setShowApplyDialog(false);
    } finally {
      setProcessing(false);
    }
  };

  if (!document || !file || loadState !== "ready") {
    return (
      <main className="upload-shell">
        <header className="landing-header">
          <Link className="brand" href="/" aria-label="Redactotron home">
            <span className="brand-mark" aria-hidden="true">
              R
            </span>
            <span>REDACTOTRON</span>
          </Link>
          <div className="privacy-chip">
            <ShieldIcon />
            Permanent, not painted over
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">PDF REDACTION, DONE PROPERLY</p>
            <h1>
              Remove the text.
              <br />
              <span>Not just the evidence.</span>
            </h1>
            <p className="hero-subtitle">
              Mark sensitive words or whole sections, review every block, then
              create a clean copy with searchable replacement text.
            </p>
            <div className="trust-row">
              <span><b>01</b> Select</span>
              <i />
              <span><b>02</b> Review</span>
              <i />
              <span><b>03</b> Remove</span>
            </div>
          </div>

          <div
            className={`upload-card ${isDraggingFile ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDraggingFile(true);
            }}
            onDragLeave={() => setIsDraggingFile(false)}
            onDrop={handleDrop}
          >
            <div className="upload-icon">
              <UploadIcon />
            </div>
            <p className="eyebrow">START WITH A DOCUMENT</p>
            <h2>
              {loadState === "loading"
                ? "Opening your PDF…"
                : "Drop a PDF right here"}
            </h2>
            <p>or choose one from your computer</p>
            <label
              className={`button button-primary upload-button ${
                loadState === "loading" ? "disabled" : ""
              }`}
              aria-disabled={loadState === "loading"}
            >
              <FileIcon />
              Choose PDF
              <input
                id="pdf-file-input"
                type="file"
                accept="application/pdf,.pdf"
                className="file-input"
                aria-label="PDF file"
                disabled={loadState === "loading"}
                onChange={handleFileInput}
              />
            </label>
            <div className="upload-limit">
              <span>PDF only</span>
              <span>Up to 4 MB</span>
              <span>100 pages</span>
            </div>
            {error && (
              <div className="inline-alert error" role="alert">
                {error}
              </div>
            )}
          </div>
        </section>

        <footer className="landing-footer">
          <div>
            <LockIcon />
            <span>
              <strong>Your original stays untouched.</strong>
              Redaction happens only when you apply it.
            </span>
          </div>
          <p>Built for documents that deserve care.</p>
        </footer>
      </main>
    );
  }

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <Link className="brand compact" href="/" aria-label="Redactotron home">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <span>REDACTOTRON</span>
        </Link>

        <div className="file-summary">
          <FileIcon />
          <div>
            <strong title={file.name}>{file.name}</strong>
            <span>
              {document.numPages} page{document.numPages === 1 ? "" : "s"} ·{" "}
              {formatBytes(file.size)}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close PDF"
            onClick={() => void resetDocument()}
          >
            <CloseIcon />
          </button>
        </div>

        <button
          type="button"
          className="button button-primary apply-button"
          disabled={!blocks.length}
          onClick={() => setShowApplyDialog(true)}
        >
          <DownloadIcon />
          Apply {blocks.length || ""} redaction{blocks.length === 1 ? "" : "s"}
        </button>
      </header>

      <div className="editor-toolbar" aria-label="Redaction toolbar">
        <div className="tool-group">
          <span className="toolbar-label">MARK WITH</span>
          <button
            type="button"
            className={`tool-button ${mode === "text" ? "active" : ""}`}
            aria-pressed={mode === "text"}
            onClick={() => setMode("text")}
          >
            <TextSelectIcon />
            Select text
            <kbd>T</kbd>
          </button>
          <button
            type="button"
            className={`tool-button ${mode === "area" ? "active" : ""}`}
            aria-pressed={mode === "area"}
            onClick={() => setMode("area")}
          >
            <AreaIcon />
            Draw area
            <kbd>A</kbd>
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="tool-group compact-tools">
          <button
            type="button"
            className="icon-button"
            aria-label="Undo"
            disabled={!past.length}
            onClick={undo}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo"
            disabled={!future.length}
            onClick={redo}
          >
            <RedoIcon />
          </button>
          <span className="toolbar-divider" />
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            disabled={scale <= 0.65}
            onClick={() =>
              setScale((current) =>
                Math.max(0.65, Number((current - 0.1).toFixed(2))),
              )
            }
          >
            <ZoomOutIcon />
          </button>
          <output className="zoom-value">{Math.round(scale * 100)}%</output>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            disabled={scale >= 1.7}
            onClick={() =>
              setScale((current) =>
                Math.min(1.7, Number((current + 0.1).toFixed(2))),
              )
            }
          >
            <ZoomInIcon />
          </button>
        </div>
      </div>

      <div className="editor-body">
        <div className="document-workspace">
          <div className="workspace-hint">
            {mode === "text" ? (
              <>
                <TextSelectIcon />
                {pageTextStatus[0] === true
                  ? "Text detected — click and drag across words. Each drag becomes one removable block."
                  : "Loading the selectable text layer…"}
              </>
            ) : (
              <>
                <AreaIcon />
                Drag a box over a whole section, image, or scanned area.
              </>
            )}
          </div>

          {notice && (
            <div
              className={`workspace-notice ${
                Object.values(pageTextStatus).some((hasText) => !hasText)
                  ? "info"
                  : "success"
              }`}
              role="status"
            >
              {notice}
            </div>
          )}
          {error && (
            <div className="workspace-notice error" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
              >
                <CloseIcon />
              </button>
            </div>
          )}

          <div className="pages">
            {Array.from({ length: document.numPages }, (_, pageIndex) => (
              <PdfPage
                key={pageIndex}
                document={document}
                pageIndex={pageIndex}
                scale={scale}
                mode={mode}
                blocks={blocks.filter(
                  (block) => block.pageIndex === pageIndex,
                )}
                selectedBlockId={selectedBlockId}
                onAddBlock={addBlock}
                onRemoveBlock={removeBlock}
                onSelectBlock={setSelectedBlockId}
                onTextLayerStatus={handleTextLayerStatus}
              />
            ))}
          </div>
        </div>

        <aside className="redaction-sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">REVIEW</p>
              <h2>Redaction queue</h2>
            </div>
            <span className="count-badge">{blocks.length}</span>
          </div>

          {blocks.length ? (
            <>
              <p className="sidebar-instruction">
                Review each block before permanently applying it.
              </p>
              <ol className="redaction-list">
                {blocks.map((block, index) => (
                  <li
                    key={block.id}
                    className={
                      selectedBlockId === block.id ? "selected" : ""
                    }
                  >
                    <button
                      type="button"
                      className="redaction-jump"
                      onClick={() => {
                        setSelectedBlockId(block.id);
                        document
                          .getPage(block.pageIndex + 1)
                          .then(() =>
                            window.document
                              .getElementById(`page-${block.pageIndex + 1}`)
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                              }),
                          );
                      }}
                    >
                      <span className="queue-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        <strong>REDACTED</strong>
                        <small>
                          Page {block.pageIndex + 1} · {block.rects.length} line
                          {block.rects.length === 1 ? "" : "s"}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button remove-queue-item"
                      aria-label={`Remove redaction ${index + 1}`}
                      onClick={() => removeBlock(block.id)}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="clear-all"
                onClick={() => {
                  commitBlocks([]);
                  setSelectedBlockId(null);
                }}
              >
                Clear all redactions
              </button>
            </>
          ) : (
            <div className="empty-queue">
              <div>
                <TextSelectIcon />
              </div>
              <h3>No redactions yet</h3>
              <p>
                Highlight text or draw an area on the document. Your marks will
                appear here.
              </p>
            </div>
          )}

          <div className="sidebar-security">
            <ShieldIcon />
            <div>
              <strong>Real content removal</strong>
              <p>
                Export deletes the selected PDF objects and inserts new,
                searchable text.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {showApplyDialog && (
        <ApplyDialog
          count={blocks.length}
          processing={processing}
          onCancel={() => setShowApplyDialog(false)}
          onConfirm={() => void applyRedactions()}
        />
      )}
    </main>
  );
}
