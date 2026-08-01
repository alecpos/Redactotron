"use client";

import { DownloadIcon, LockIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  useComponentLayout,
  type ComponentLayoutInput,
} from "@/lib/ui/theme-system";

type ApplyDialogProps = {
  count: number;
  processing: boolean;
  layout?: ComponentLayoutInput;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ApplyDialog({
  count,
  processing,
  layout = "responsive",
  onCancel,
  onConfirm,
}: ApplyDialogProps) {
  const resolvedLayout = useComponentLayout(layout);

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog"
        data-component="apply-dialog"
        data-layout={resolvedLayout}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="apply-title"
        aria-describedby="apply-description"
      >
        <div className="dialog-icon">
          <LockIcon />
        </div>
        <p className="eyebrow">FINAL STEP</p>
        <h2 id="apply-title">
          Permanently apply {count} redaction{count === 1 ? "" : "s"}?
        </h2>
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
          <Button
            type="button"
            variant="secondary"
            layout={resolvedLayout}
            onClick={onCancel}
            disabled={processing}
          >
            Keep editing
          </Button>
          <Button
            type="button"
            variant="primary"
            layout={resolvedLayout}
            onClick={onConfirm}
            disabled={processing}
          >
            <DownloadIcon />
            {processing ? "Creating secure PDF…" : "Apply & download"}
          </Button>
        </div>
      </section>
    </div>
  );
}
