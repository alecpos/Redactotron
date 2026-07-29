import type { PiiFinding } from "@/lib/pii/types";

type Recognizer = {
  category: string;
  pattern: RegExp;
  confidence: number;
  validate?: (value: string) => boolean;
};

// ISO 13616-compliant national lengths from the SWIFT IBAN Registry,
// Release 102 (June 2026).
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 32,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
};

const recognizers: Recognizer[] = [
  {
    category: "EMAIL_ADDRESS",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    confidence: 0.99,
  },
  {
    category: "US_SSN",
    pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/gu,
    confidence: 0.99,
    validate: isValidSsn,
  },
  {
    category: "PHONE_NUMBER",
    pattern:
      /(?<![\d+])(?:(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}|\+(?:\d[\s().-]?){7,14}\d)(?![\s().-]?\d)/gu,
    confidence: 0.97,
    validate: (value) => {
      const length = value.replace(/\D/g, "").length;
      return length >= 10 && length <= 15;
    },
  },
  {
    category: "CREDIT_CARD",
    pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu,
    confidence: 0.99,
    validate: (value) => passesLuhn(value.replace(/\D/g, "")),
  },
  {
    category: "IBAN_CODE",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/gu,
    confidence: 0.98,
    validate: passesIbanMod97,
  },
];

function isValidSsn(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  return (
    area !== 0 &&
    area !== 666 &&
    area < 900 &&
    digits.slice(3, 5) !== "00" &&
    digits.slice(5) !== "0000"
  );
}

function passesLuhn(digits: string) {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) {
    return false;
  }

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function passesIbanMod97(value: string) {
  const compact = value.replace(/\s/g, "").toUpperCase();
  if (compact.length !== IBAN_LENGTHS[compact.slice(0, 2)]) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;

  for (const character of rearranged) {
    const numeric = /\d/.test(character)
      ? character
      : String(character.charCodeAt(0) - 55);
    for (const digit of numeric) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

function passesAbaRoutingChecksum(digits: string) {
  if (!/^\d{9}$/u.test(digits)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return (
    [...digits].reduce(
      (sum, digit, index) => sum + Number(digit) * weights[index],
      0,
    ) %
      10 ===
    0
  );
}

function contextualAccountFindings(text: string): PiiFinding[] {
  const pattern =
    /\b(?:account|acct|routing)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([0-9][0-9 -]{3,20}[0-9])\b/giu;
  const findings: PiiFinding[] = [];

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) continue;
    const digits = match[1].replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 17) continue;
    const isRouting = /routing/i.test(match[0]);
    if (isRouting && !passesAbaRoutingChecksum(digits)) continue;
    const relativeStart = match[0].lastIndexOf(match[1]);
    findings.push({
      start: match.index + relativeStart,
      end: match.index + relativeStart + match[1].length,
      category: isRouting ? "US_BANK_NUMBER" : "ACCOUNT_NUMBER",
      confidence: 0.96,
      source: "recognizer",
    });
  }
  return findings;
}

export function findStructuredPii(text: string): PiiFinding[] {
  const findings = contextualAccountFindings(text);

  for (const recognizer of recognizers) {
    for (const match of text.matchAll(recognizer.pattern)) {
      if (match.index === undefined) continue;
      const value = match[0];
      if (recognizer.validate && !recognizer.validate(value)) continue;
      findings.push({
        start: match.index,
        end: match.index + value.length,
        category: recognizer.category,
        confidence: recognizer.confidence,
        source: "recognizer",
      });
    }
  }

  return findings.sort((left, right) => left.start - right.start);
}
