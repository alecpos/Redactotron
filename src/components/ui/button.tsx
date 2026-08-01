"use client";

import type { ButtonHTMLAttributes } from "react";
import {
  useComponentLayout,
  type ComponentLayoutInput,
} from "@/lib/ui/theme-system";

export type ButtonStyle = "primary" | "secondary";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  layout?: ComponentLayoutInput;
  variant?: ButtonStyle;
};

export function Button({
  layout = "responsive",
  variant = "primary",
  className,
  ...props
}: ButtonProps) {
  const resolvedLayout = useComponentLayout(layout);
  const classes = ["button", `button-${variant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...props}
      className={classes}
      data-component="button"
      data-layout={resolvedLayout}
    />
  );
}
