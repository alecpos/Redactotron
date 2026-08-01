import type { Metadata } from "next";
import { RedactotronThemeProvider } from "@/lib/ui/theme-system";
import "./globals.css";
import "./responsive-theme.css";

export const metadata: Metadata = {
  title: "Redactotron - Permanent document redaction",
  description:
    "Import documents and images, review sensitive content, and export a searchable redacted PDF.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <RedactotronThemeProvider>{children}</RedactotronThemeProvider>
      </body>
    </html>
  );
}
