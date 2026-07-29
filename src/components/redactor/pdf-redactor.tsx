"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
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
  SparkIcon,
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
import {
  SUPPORTED_DOCUMENT_LABEL,
  importDocumentAsPdf,
  type DocumentKind,
} from "@/lib/importers/document-to-pdf";
import type {
  RedactionBlock,
  ToolMode,
} from "@/lib/pdf/types";
import { redactionManifestSchema } from "@/lib/pdf/redaction-schema";
import { mergeSuggestionBlocks } from "@/lib/pii/suggestions";

const MAX_FILE_BYTES = 4_000_000;
const MAX_PAGES = 100;
const MAX_BLOCKS = 200;

type LoadState = "idle" | "loading" | "ready" | "error";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function outputFilename(name: string) {
  const withoutExtension = name.replace(/\.[^.]+$/i, "");
  return `${withoutExtension || "document"}-redacted.pdf`;
}

export function PdfRedactor() {
  const dragDepthRef = useRef(0);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentKind, setDocumentKind] = useState<DocumentKind | null>(null);
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
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [pageTextStatus, setPageTextStatus] = useState<
    Record<number, boolean>
  >({});
  const blocksRef = useRef<RedactionBlock[]>([]);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const scanGenerationRef = useRef(0);
  const scanningRef = useRef(false);
  const [pickerStatus, setPickerStatus] = useState<string | null>(null);

  const commitBlocks = useCallback(
    (next: RedactionBlock[]) => {
      setPast((history) => [...history.slice(-49), blocksRef.current]);
      blocksRef.current = next;
      setBlocks(next);
      setFuture([]);
    },
    [],
  );

  const resetDocument = useCallback(async () => {
    scanGenerationRef.current += 1;
    scanningRef.current = false;
    const currentDocument = documentRef.current;
    documentRef.current = null;
    setScanning(false);
    await currentDocument?.loadingTask.destroy();
    setDocument(null);
    setSourceFile(null);
    setFile(null);
    blocksRef.current = [];
    setDocumentKind(null);
    setBlocks([]);
    setPast([]);
    setFuture([]);
    setError(null);
    setNotice(null);
    setLoadState("idle");
    setSelectedBlockId(null);
    setPageTextStatus({});
    setScanning(false);
    setScanProgress(null);
  }, []);

  const loadFile = useCallback(
    async (nextFile: File) => {
      const loadGeneration = scanGenerationRef.current + 1;
      scanGenerationRef.current = loadGeneration;
      scanningRef.current = false;
      setError(null);
      setNotice(null);
      setLoadState("loading");

      try {
        if (nextFile.size > MAX_FILE_BYTES) {
          throw new Error(
            `Documents are limited to ${formatBytes(MAX_FILE_BYTES)} in this version.`,
          );
        }

        const imported = await importDocumentAsPdf(
          nextFile,
          ({ message }) => setPickerStatus(message),
        );
        const workingFile = imported.pdfFile;
        if (workingFile.size > MAX_FILE_BYTES) {
          throw new Error(
            `The searchable PDF is larger than ${formatBytes(MAX_FILE_BYTES)}. Use a smaller source file.`,
          );
        }

        const signature = await workingFile.slice(0, 5).text();
        if (signature !== "%PDF-") {
          throw new Error("The document could not be converted into a valid PDF.");
        }

        const currentDocument = documentRef.current;
        documentRef.current = null;
        await currentDocument?.loadingTask.destroy();
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const data = new Uint8Array(await workingFile.arrayBuffer());
        const task = pdfjs.getDocument({ data });
        const nextDocument = await task.promise;

        if (scanGenerationRef.current !== loadGeneration) {
          await nextDocument.loadingTask.destroy();
          return;
        }
        if (nextDocument.numPages > MAX_PAGES) {
          await nextDocument.loadingTask.destroy();
          throw new Error(`PDFs are limited to ${MAX_PAGES} pages.`);
        }

        documentRef.current = nextDocument;
        setSourceFile(nextFile);
        setFile(workingFile);
        setDocumentKind(imported.kind);
        setDocument(nextDocument);
        blocksRef.current = [];
        setBlocks([]);
        setPast([]);
        setFuture([]);
        setScale(1);
        setMode("text");
        setSelectedBlockId(null);
        setPageTextStatus({});
        setScanning(false);
        setScanProgress(null);
        setNotice(imported.notice);
        setLoadState("ready");
        setPickerStatus(null);
      } catch (caught) {
        setLoadState("error");
        setError(
          caught instanceof Error
            ? caught.message
            : "The document could not be opened.",
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (document || loadState === "loading") return;

    const isFileDrag = (event: globalThis.DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) return false;
      if (Array.from(transfer.types ?? []).includes("Files")) return true;
      if (transfer.files.length > 0) return true;

      for (let index = 0; index < transfer.items.length; index += 1) {
        if (transfer.items[index].kind === "file") return true;
      }
      return false;
    };

    const onDragEnter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFile(true);
      setPickerStatus("Document detected — release anywhere to open it.");
    };

    const onDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setIsDraggingFile(true);
    };

    const onDragLeave = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDraggingFile(false);
    };

    const onDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDraggingFile(false);

      const transfer = event.dataTransfer;
      const files = Array.from(transfer?.files ?? []);
      let nextFile =
        files.find(
          (candidate) =>
            /\.(pdf|docx|txt|png|jpe?g)$/i.test(candidate.name),
        ) ??
        files[0] ??
        null;

      if (!nextFile && transfer?.items) {
        for (let index = 0; index < transfer.items.length; index += 1) {
          const item = transfer.items[index];
          if (item.kind !== "file") continue;
          const candidate = item.getAsFile();
          if (!candidate) continue;
          nextFile = candidate;
          if (/\.(pdf|docx|txt|png|jpe?g)$/i.test(candidate.name)) {
            break;
          }
        }
      }

      if (!nextFile) {
        setPickerStatus(
          "The browser detected the drop but did not provide the file. Use Choose document instead.",
        );
        return;
      }

      setPickerStatus(`Drop received: ${nextFile.name}. Opening…`);
      void loadFile(nextFile);
    };

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);

    return () => {
      dragDepthRef.current = 0;
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [document, loadFile, loadState]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) {
      setPickerStatus(
        `Selected ${nextFile.name || "document"}. Opening…`,
      );
      void loadFile(nextFile);
    }
    event.target.value = "";
  };

  const addBlock = useCallback(
    (block: RedactionBlock) => {
      const current = blocksRef.current;
      if (current.length >= MAX_BLOCKS) {
        setError(`A document can contain up to ${MAX_BLOCKS} redaction blocks.`);
        return;
      }
      commitBlocks([...current, block]);
      setSelectedBlockId(block.id);
      setNotice(null);
    },
    [commitBlocks],
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
      commitBlocks(blocksRef.current.filter((block) => block.id !== id));
      setSelectedBlockId((selected) => (selected === id ? null : selected));
    },
    [commitBlocks],
  );

  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous) return;
    setFuture((history) => [blocksRef.current, ...history].slice(0, 50));
    blocksRef.current = previous;
    setBlocks(previous);
    setPast((history) => history.slice(0, -1));
    setSelectedBlockId(null);
  }, [past]);

  const redo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    setPast((history) => [...history, blocksRef.current].slice(-50));
    blocksRef.current = next;
    setBlocks(next);
    setFuture((history) => history.slice(1));
    setSelectedBlockId(null);
  }, [future]);

  const scanSensitiveData = async () => {
    const scanDocument = documentRef.current;
    if (!scanDocument || scanningRef.current) return;
    const scanGeneration = scanGenerationRef.current + 1;
    scanGenerationRef.current = scanGeneration;
    scanningRef.current = true;
    setScanning(true);
    setError(null);
    setNotice(null);

    try {
      const [{ detectPii }, { extractPageText, findingToBlock }] =
        await Promise.all([
          import("@/lib/pii/detector"),
          import("@/lib/pii/pdf-text"),
        ]);
      const suggestions: RedactionBlock[] = [];
      let modelAvailable = true;
      let pagesWithoutText = 0;

      for (
        let pageIndex = 0;
        pageIndex < scanDocument.numPages &&
        blocksRef.current.length + suggestions.length < MAX_BLOCKS;
        pageIndex += 1
      ) {
        if (
          scanGenerationRef.current !== scanGeneration ||
          documentRef.current !== scanDocument
        ) {
          return;
        }
        setScanProgress(
          `Scanning page ${pageIndex + 1} of ${scanDocument.numPages} on this device…`,
        );
        const page = await extractPageText(scanDocument, pageIndex);
        if (!page.text.trim()) {
          pagesWithoutText += 1;
          continue;
        }
        const result = await detectPii(page.text);
        if (
          scanGenerationRef.current !== scanGeneration ||
          documentRef.current !== scanDocument
        ) {
          return;
        }
        modelAvailable &&= result.modelAvailable;
        for (const finding of result.findings) {
          const block = findingToBlock(page, finding);
          if (block) suggestions.push(block);
        }
      }

      if (
        scanGenerationRef.current !== scanGeneration ||
        documentRef.current !== scanDocument
      ) {
        return;
      }
      const merged = mergeSuggestionBlocks(
        blocksRef.current,
        suggestions,
        MAX_BLOCKS,
      );
      const unique = merged.added;

      if (unique.length) {
        commitBlocks(merged.blocks);
        setSelectedBlockId(unique[0].id);
      }

      const fallback = modelAvailable
        ? ""
        : " The contextual model was unavailable, so only structured patterns were used.";
      const scans = pagesWithoutText
        ? ` ${pagesWithoutText} page${pagesWithoutText === 1 ? " needs" : "s need"} manual area review because no searchable text was found.`
        : "";
      setNotice(
        unique.length
          ? `${unique.length} suggestion${unique.length === 1 ? "" : "s"} added to the review queue.${fallback}${scans}`
          : `No new sensitive-data suggestions were found.${fallback}${scans}`,
      );
    } catch (caught) {
      if (
        scanGenerationRef.current !== scanGeneration ||
        documentRef.current !== scanDocument
      ) {
        return;
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "The document could not be scanned.",
      );
    } finally {
      if (
        scanGenerationRef.current === scanGeneration &&
        documentRef.current === scanDocument
      ) {
        scanningRef.current = false;
        setScanning(false);
        setScanProgress(null);
      }
    }
  };

  useEffect(
    () => () => {
      scanGenerationRef.current += 1;
      scanningRef.current = false;
      const currentDocument = documentRef.current;
      documentRef.current = null;
      void currentDocument?.loadingTask.destroy();
    },
    [],
  );

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
    if (!file || !sourceFile || !blocks.length) return;
    setProcessing(true);
    setError(null);
    setNotice(null);

    try {
      const manifest = redactionManifestSchema.parse({ blocks });
      const formData = new FormData();
      formData.append("file", file, outputFilename(sourceFile.name));
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
      anchor.download = outputFilename(sourceFile.name);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);

      setShowApplyDialog(false);
      setNotice(
        `Secure copy created: ${outputFilename(sourceFile.name)}. Your original is unchanged.`,
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

  if (!document || !file || !sourceFile || loadState !== "ready") {
    return (
      <main className="upload-shell">
        {isDraggingFile && (
          <div className="global-drop-overlay" aria-live="assertive">
            <div className="global-drop-message">
              <span className="global-drop-icon" aria-hidden="true">
                <UploadIcon />
              </span>
              <strong>Drop document to open</strong>
              <span>Release anywhere in this window</span>
            </div>
          </div>
        )}

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
            <p className="eyebrow">DOCUMENT REDACTION, DONE PROPERLY</p>
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

          <div className={`upload-card ${isDraggingFile ? "dragging" : ""}`}>
            <div className="upload-icon">
              <UploadIcon />
            </div>
            <p className="eyebrow">START WITH A DOCUMENT</p>
            <h2>
              {loadState === "loading"
                ? "Preparing your document…"
                : "Drop a document right here"}
            </h2>
            <p>or choose one from your computer</p>
            <label
              className={`button button-primary upload-button ${
                loadState === "loading" ? "disabled" : ""
              }`}
            >
              <FileIcon />
              Choose document
              <input
                id="pdf-file-input"
                type="file"
                className="native-file-fallback"
                aria-label="Choose document"
                disabled={loadState === "loading"}
                onClick={() => {
                  setError(null);
                  setPickerStatus("Opening your computer’s file picker…");
                }}
                onChange={handleFileInput}
              />
            </label>
            {pickerStatus && (
              <p className="picker-status" role="status">
                {pickerStatus}
              </p>
            )}
            <div className="upload-limit">
              <span>{SUPPORTED_DOCUMENT_LABEL}</span>
              <span>Up to 4 MB</span>
              <span>PDF output</span>
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
            <strong title={sourceFile.name}>{sourceFile.name}</strong>
            <span>
              {document.numPages} page{document.numPages === 1 ? "" : "s"} ·{" "}
              {formatBytes(sourceFile.size)}
              {documentKind && documentKind !== "pdf"
                ? ` · ${documentKind === "image" ? "OCR import" : "converted"}`
                : ""}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close document"
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
            className="tool-button scan-button"
            disabled={scanning}
            onClick={() => void scanSensitiveData()}
          >
            <SparkIcon />
            {scanning ? "Scanning…" : "Find sensitive data"}
          </button>
          <span className="toolbar-divider" />
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
          {scanProgress && (
            <div className="workspace-notice info" role="status">
              <span className="scan-progress">
                <SparkIcon />
                {scanProgress}
              </span>
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
                        <strong>
                          {block.suggestion
                            ? block.suggestion.category.replaceAll("_", " ")
                            : "REDACTED"}
                        </strong>
                        <small>
                          Page {block.pageIndex + 1} ·{" "}
                          {block.suggestion
                            ? `${Math.round(block.suggestion.confidence * 100)}% suggestion`
                            : `${block.rects.length} line${block.rects.length === 1 ? "" : "s"}`}
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
                Export deletes content inside each selected area and inserts
                new, searchable text.
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
