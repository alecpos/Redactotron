"use client";

import { DownloadIcon, LockIcon } from "@/components/icons";

type ApplyDialogProps = {
  count: number;
  processing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ApplyDialog({
  count,
  processing,
  onCancel,
  onConfirm,
}: ApplyDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="apply-title"
        aria-describedby="apply-description"
      >
        <div className="dialog-icon">
          <LockIcon />
        </div>
        <p className="eyebrow">FINAL STEP</p>
        <h2 id="apply-title">Permanently apply {count} redaction{count === 1 ? "" : "s"}?</h2>
        <p id="apply-description">
          This creates a new PDF and permanently removes the selected content.
          The file is processed entirely on this device, and your original
          stays unchanged.
        </p>
        <div className="dialog-note">
          <span aria-hidden="true">✓</span>
          Nothing is uploaded. Unredacted text and “REDACTED” labels remain
          searchable.
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={processing}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onConfirm}
            disabled={processing}
          >
            <DownloadIcon />
            {processing ? "Creating secure PDF…" : "Apply & download"}
          </button>
        </div>
      </section>
    </div>
  );
}
