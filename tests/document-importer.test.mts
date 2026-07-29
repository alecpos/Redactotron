import assert from "node:assert/strict";
import test from "node:test";
import { flattenOcrWords } from "../src/lib/importers/document-to-pdf.ts";

test("OCR word flattening tolerates incomplete multi-page results", () => {
  const validWord = {
    text: "SECOND PAGE",
    confidence: 94,
    bbox: { x0: 10, y0: 20, x1: 110, y1: 45 },
  };

  const words = flattenOcrWords([
    {},
    { paragraphs: null },
    { paragraphs: [{}] },
    { paragraphs: [{ lines: null }] },
    { paragraphs: [{ lines: [{}] }] },
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                null,
                { text: "missing geometry", confidence: 90 },
                { ...validWord, confidence: Number.NaN },
                validWord,
              ],
            },
          ],
        },
      ],
    },
  ]);

  assert.equal(words.length, 1);
  assert.equal(words[0], validWord);
  assert.deepEqual(flattenOcrWords(undefined), []);
  assert.deepEqual(flattenOcrWords({}), []);
});
