import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : /\.(?:ts|tsx|js|mjs)$/u.test(entry.name)
          ? [path]
          : [];
    }),
  );
  return files.flat();
}

test("document code has no upload or remote runtime path", async () => {
  const files = await sourceFiles("src");
  const contents = await Promise.all(
    files.map(async (path) => [path, await readFile(path, "utf8")] as const),
  );

  for (const [path, source] of contents) {
    assert.equal(
      /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/u.test(
        source,
      ),
      false,
      `${path} contains an application network call`,
    );
    assert.equal(
      /https?:\/\//u.test(source),
      false,
      `${path} contains a remote runtime URL`,
    );
    assert.equal(
      source.includes("/api/redact"),
      false,
      `${path} references the removed upload endpoint`,
    );
  }

  const model = await readFile("src/lib/pii/model.ts", "utf8");
  assert.match(model, /allowRemoteModels\s*=\s*false/u);
  assert.match(model, /localModelPath\s*=\s*"\/models\/"/u);
  assert.match(model, /device:\s*"wasm"/u);

  const importer = await readFile(
    "src/lib/importers/document-to-pdf.ts",
    "utf8",
  );
  assert.match(importer, /corePath:\s*"\/tesseract\/core"/u);
  assert.match(importer, /langPath:\s*"\/tesseract\/lang"/u);
  assert.match(importer, /workerPath:\s*"\/tesseract\/worker\.min\.js"/u);

  const nextConfig = await readFile("next.config.ts", "utf8");
  assert.match(nextConfig, /connect-src 'self'/u);

  const redactor = await readFile(
    "src/components/redactor/pdf-redactor.tsx",
    "utf8",
  );
  assert.doesNotMatch(redactor, /MAX_FILE_BYTES|4_000_000|Up to 4 MB/u);

  await assert.rejects(access("api/redact.py"));
});
