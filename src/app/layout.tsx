import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Redactotron - Permanent PDF redaction",
  description:
    "Select, review, and permanently remove sensitive content from PDFs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
