import assert from "node:assert/strict";
import test from "node:test";
import { mergeFindings } from "../src/lib/pii/detector.ts";
import {
  normalizeTokenResults,
  splitTextIntoChunks,
} from "../src/lib/pii/model.ts";
import { findingToBlock } from "../src/lib/pii/pdf-text.ts";
import { findStructuredPii } from "../src/lib/pii/recognizers.ts";
import { mergeSuggestionBlocks } from "../src/lib/pii/suggestions.ts";
import type { RedactionBlock } from "../src/lib/pdf/types.ts";

test("recognizes high-confidence structured identifiers", () => {
  const text =
    "Email jane.doe@example.com, phone (212) 555-0199, SSN 123-45-6789, Visa 4111 1111 1111 1111.";
  const categories = findStructuredPii(text).map(
    (finding) => finding.category,
  );

  assert.deepEqual(categories, [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "US_SSN",
    "CREDIT_CARD",
  ]);
});

test("rejects invalid SSNs and credit-card checksums", () => {
  const findings = findStructuredPii(
    "Invalid SSNs 000-12-3456 and 666-12-3456; card 4111 1111 1111 1112.",
  );
  assert.deepEqual(findings, []);
});

test("validates routing checksums and recognizes explicitly international phones", () => {
  const text =
    "Routing number: 021000021; invalid routing number: 021000022; London +44 20 7946 0958.";
  const findings = findStructuredPii(text);

  assert.deepEqual(
    findings.map((finding) => ({
      category: finding.category,
      value: text.slice(finding.start, finding.end),
    })),
    [
      { category: "US_BANK_NUMBER", value: "021000021" },
      { category: "PHONE_NUMBER", value: "+44 20 7946 0958" },
    ],
  );
});

test("rejects overlong international phones", () => {
  assert.deepEqual(
    findStructuredPii("Too long: +1 234 567 890 123 456"),
    [],
  );
});

test("requires registered IBAN countries, lengths, and checksums", () => {
  const text =
    "Valid GB29NWBK60161331926819; bad checksum GB28NWBK60161331926819; fake country ZZ8112345678901; wrong GB length GB49WEST123456987654321.";
  const findings = findStructuredPii(text);

  assert.deepEqual(
    findings.map((finding) => text.slice(finding.start, finding.end)),
    ["GB29NWBK60161331926819"],
  );
});

test("does not absorb separators after payment-card findings", () => {
  const text = "Card 4111 1111 1111 1111 then continue.";
  const card = findStructuredPii(text).find(
    (finding) => finding.category === "CREDIT_CARD",
  );

  assert.ok(card);
  assert.equal(text.slice(card.start, card.end), "4111 1111 1111 1111");
});

test("requires account context before flagging short numbers", () => {
  const text = "Invoice 123456; account number: 9876 5432.";
  const findings = findStructuredPii(text);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "ACCOUNT_NUMBER");
  assert.equal(text.slice(findings[0].start, findings[0].end), "9876 5432");
});

test("prefers deterministic findings over overlapping model output", () => {
  const findings = mergeFindings([
    {
      start: 0,
      end: 20,
      category: "PERSON",
      confidence: 0.91,
      source: "model",
    },
    {
      start: 0,
      end: 20,
      category: "EMAIL_ADDRESS",
      confidence: 0.99,
      source: "recognizer",
    },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "EMAIL_ADDRESS");
});

test("coalesces partial duplicate model findings from chunk overlap", () => {
  const findings = mergeFindings([
    {
      start: 100,
      end: 112,
      category: "PERSON",
      confidence: 0.91,
      source: "model",
    },
    {
      start: 106,
      end: 119,
      category: "PERSON",
      confidence: 0.93,
      source: "model",
    },
  ]);

  assert.deepEqual(findings, [
    {
      start: 100,
      end: 119,
      category: "PERSON",
      confidence: 0.93,
      source: "model",
    },
  ]);
});

test("maps BERT wordpieces back to source offsets and joins BIO entities", () => {
  const text = "Jane Doe lives in Brooklyn.";
  const findings = normalizeTokenResults(text, [
    { entity: "B-PERSON", score: 0.99, word: "jane" },
    { entity: "I-PERSON", score: 0.98, word: "doe" },
    { entity: "B-LOCATION", score: 0.97, word: "brooklyn" },
  ]);

  assert.deepEqual(
    findings.map(({ category, start, end }) => ({
      category,
      value: text.slice(start, end),
    })),
    [
      { category: "PERSON", value: "Jane Doe" },
      { category: "LOCATION", value: "Brooklyn" },
    ],
  );
});

test("fallback token matching preserves offsets after Unicode case expansion", () => {
  const text = "İ Jane";
  const findings = normalizeTokenResults(text, [
    { entity: "B-PERSON", score: 0.99, word: "jane" },
  ]);

  assert.equal(text.slice(findings[0].start, findings[0].end), "Jane");
  assert.deepEqual(
    { start: findings[0].start, end: findings[0].end },
    { start: 2, end: 6 },
  );
});

test("chunking covers long text with bounded overlap and stable offsets", () => {
  const text = `${"word ".repeat(250)}Jane Doe`;
  const chunks = splitTextIntoChunks(text);

  assert.ok(chunks.length > 2);
  assert.equal(chunks[0].offset, 0);
  assert.equal(
    chunks.at(-1)?.text.slice(-8),
    "Jane Doe",
  );
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    assert.ok(current.offset > previous.offset);
    assert.ok(current.offset < previous.offset + previous.text.length);
    assert.equal(
      text.slice(current.offset, current.offset + current.text.length),
      current.text,
    );
  }
});

function block(id: string, x0: number, suggestion = false): RedactionBlock {
  return {
    id,
    pageIndex: 0,
    rects: [{ x0, y0: 10, x1: x0 + 20, y1: 30 }],
    labelRectIndex: 0,
    replacement: "REDACTED",
    appearance: "text-replacement",
    suggestion: suggestion
      ? { category: "PERSON", confidence: 0.9, source: "model" }
      : undefined,
  };
}

test("suggestion merging preserves current manual blocks and removes same-scan duplicates", () => {
  const manual = block("manual", 10);
  const candidate = block("candidate", 100, true);
  const duplicate = block("duplicate", 102, true);
  const merged = mergeSuggestionBlocks(
    [manual],
    [candidate, duplicate],
    200,
  );

  assert.deepEqual(
    merged.blocks.map(({ id }) => id),
    ["manual", "candidate"],
  );
  assert.deepEqual(
    merged.added.map(({ id }) => id),
    ["candidate"],
  );
});

test("PDF finding rectangles use measured proportional glyph advances", () => {
  const weights: Record<string, number> = {
    W: 20,
    i: 0.2,
    " ": 2,
    "@": 8,
    ".": 2,
  };
  const measure = (value: string) =>
    [...value].reduce(
      (total, character) => total + (weights[character] ?? 5),
      0,
    );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          font: "",
          measureText: (value: string) => ({ width: measure(value) }),
        }),
      }),
    },
  });

  const text = "WWWWiiii jane@example.com";
  const start = text.indexOf("jane@example.com");
  const width = 200;
  const result = findingToBlock(
    {
      pageIndex: 0,
      text,
      segments: [
        {
          start: 0,
          end: text.length,
          text,
          dir: "ltr",
          rect: { x0: 70, y0: 90, x1: 275, y1: 110 },
          transform: [12, 0, 0, 12, 72, 100],
          width,
          height: 12,
          fontFamily: "sans-serif",
        },
      ],
    },
    {
      start,
      end: text.length,
      category: "EMAIL_ADDRESS",
      confidence: 0.99,
      source: "recognizer",
    },
  );

  assert.ok(result);
  const expectedStart = 72 + width * (measure(text.slice(0, start)) / measure(text));
  assert.ok(Math.abs(result.rects[0].x0 - (expectedStart - 1.44)) < 0.001);
  assert.ok(
    Math.abs(result.rects[0].x0 - (72 + width * (start / text.length))) > 10,
  );
});

test("PDF finding rectangles follow rotated text transforms", () => {
  const page = {
    pageIndex: 0,
    text: "Rotated jane@example.com",
    segments: [
      {
        start: 0,
        end: 24,
        text: "Rotated jane@example.com",
        dir: "ltr",
        rect: { x0: 100, y0: 90, x1: 120, y1: 300 },
        transform: [0, 12, -12, 0, 120, 92] as [
          number,
          number,
          number,
          number,
          number,
          number,
        ],
        width: 200,
        height: 12,
        fontFamily: "sans-serif",
      },
    ],
  };
  const start = page.text.indexOf("jane@example.com");
  const result = findingToBlock(page, {
    start,
    end: start + "jane@example.com".length,
    category: "EMAIL_ADDRESS",
    confidence: 0.99,
    source: "recognizer",
  });

  assert.ok(result);
  const [rect] = result.rects;
  assert.ok(rect.y1 - rect.y0 > (rect.x1 - rect.x0) * 4);
});
