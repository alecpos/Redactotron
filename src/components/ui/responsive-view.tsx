"use client";

import type { ReactNode } from "react";
import {
  ComponentLayoutScope,
  RedactotronThemePreviewProvider,
  VIEWPORT_WIDTHS,
  type ComponentLayout,
  type ComponentLayoutInput,
} from "@/lib/ui/theme-system";

export function ResponsiveView({
  children,
  layout = "responsive",
  className,
}: {
  children: ReactNode;
  layout?: ComponentLayoutInput;
  className?: string;
}) {
  return (
    <ComponentLayoutScope layout={layout} className={className}>
      {children}
    </ComponentLayoutScope>
  );
}

export function ResponsiveViewPreview({
  children,
  layout,
}: {
  children: ReactNode;
  layout: ComponentLayout;
}) {
  return (
    <RedactotronThemePreviewProvider width={VIEWPORT_WIDTHS[layout]}>
      {children}
    </RedactotronThemePreviewProvider>
  );
}
