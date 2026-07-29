import type { PiiFinding } from "@/lib/pii/types";

type Recognizer = {
  category: string;
  pattern: RegExp;
  confidence: number;
  validate?: (value: string) => boolean;
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
      /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\d)/gu,
    confidence: 0.97,
    validate: (value) => value.replace(/\D/g, "").length >= 10,
  },
  {
    category: "CREDIT_CARD",
    pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu,
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
  if (compact.length < 15 || compact.length > 34) return false;
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

function contextualAccountFindings(text: string): PiiFinding[] {
  const pattern =
    /\b(?:account|acct|routing)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([0-9][0-9 -]{3,20}[0-9])\b/giu;
  const findings: PiiFinding[] = [];

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) continue;
    const digits = match[1].replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 17) continue;
    const relativeStart = match[0].lastIndexOf(match[1]);
    findings.push({
      start: match.index + relativeStart,
      end: match.index + relativeStart + match[1].length,
      category: /routing/i.test(match[0]) ? "US_BANK_NUMBER" : "ACCOUNT_NUMBER",
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
