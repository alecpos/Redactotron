import assert from "node:assert/strict";
import test from "node:test";
import { mergeFindings } from "../src/lib/pii/detector.ts";
import { normalizeTokenResults } from "../src/lib/pii/model.ts";
import { findStructuredPii } from "../src/lib/pii/recognizers.ts";

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
