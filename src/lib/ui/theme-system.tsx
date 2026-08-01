"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ComponentLayout = "small" | "medium" | "full";
export type ComponentLayoutInput = ComponentLayout | "responsive";

export const VIEWPORT_WIDTHS = {
  small: 390,
  medium: 1024,
  full: 1210,
} as const;

export const THEME_TOKENS = {
  small: {
    screenGutter: 16,
    sectionGap: 32,
    controlGap: 8,
    contentMax: 358,
    sidebarWidth: 0,
    controlHeight: 44,
    titleSize: 24,
    bodySize: 14,
    labelSize: 12,
  },
  medium: {
    screenGutter: 32,
    sectionGap: 40,
    controlGap: 10,
    contentMax: 960,
    sidebarWidth: 250,
    controlHeight: 44,
    titleSize: 28,
    bodySize: 15,
    labelSize: 13,
  },
  full: {
    screenGutter: 48,
    sectionGap: 48,
    controlGap: 12,
    contentMax: 1114,
    sidebarWidth: 300,
    controlHeight: 48,
    titleSize: 32,
    bodySize: 16,
    labelSize: 14,
  },
} as const satisfies Record<ComponentLayout, Record<string, number>>;

export function resolveComponentLayout(width: number): ComponentLayout {
  if (width <= VIEWPORT_WIDTHS.small) return "small";
  if (width <= VIEWPORT_WIDTHS.medium) return "medium";
  return "full";
}

type ThemeContextValue = {
  layout: ComponentLayout;
  viewportWidth: number;
  tokens: (typeof THEME_TOKENS)[ComponentLayout];
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getBrowserWidth() {
  return typeof window === "undefined" ? VIEWPORT_WIDTHS.full : window.innerWidth;
}

export function RedactotronThemeProvider({
  children,
  width,
}: {
  children: ReactNode;
  width?: number;
}) {
  const [browserWidth, setBrowserWidth] = useState(getBrowserWidth);
  const viewportWidth = width ?? browserWidth;
  const layout = resolveComponentLayout(viewportWidth);

  useEffect(() => {
    if (width !== undefined) return;
    const update = () => setBrowserWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, [width]);

  const value = useMemo(
    () => ({ layout, viewportWidth, tokens: THEME_TOKENS[layout] }),
    [layout, viewportWidth],
  );

  return (
    <ThemeContext.Provider value={value}>
      <div
        className="redactotron-theme"
        data-layout={layout}
        data-viewport-width={viewportWidth}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function RedactotronThemePreviewProvider({
  children,
  width,
}: {
  children: ReactNode;
  width: (typeof VIEWPORT_WIDTHS)[ComponentLayout];
}) {
  return (
    <div style={{ width }}>
      <RedactotronThemeProvider width={width}>
        {children}
      </RedactotronThemeProvider>
    </div>
  );
}

export function useRedactotronTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error(
      "useRedactotronTheme must be used inside RedactotronThemeProvider.",
    );
  }
  return value;
}

export function useComponentLayout(
  layout: ComponentLayoutInput = "responsive",
): ComponentLayout {
  const theme = useRedactotronTheme();
  return layout === "responsive" ? theme.layout : layout;
}

export function ComponentLayoutScope({
  children,
  layout = "responsive",
  className,
}: {
  children: ReactNode;
  layout?: ComponentLayoutInput;
  className?: string;
}) {
  const resolved = useComponentLayout(layout);
  return (
    <div className={className} data-layout={resolved}>
      {children}
    </div>
  );
}
