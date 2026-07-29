import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
