import { findContextualPii } from "./model.ts";
import { findStructuredPii } from "./recognizers.ts";
import type { PiiFinding, PiiScanResult } from "./types.ts";

function overlapRatio(left: PiiFinding, right: PiiFinding) {
  const overlap = Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
  return overlap / Math.max(1, Math.min(left.end - left.start, right.end - right.start));
}

export function mergeFindings(findings: PiiFinding[]) {
  const coalesced: PiiFinding[] = [];
  for (const finding of [...findings].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    const previous = coalesced[coalesced.length - 1];
    if (
      previous &&
      previous.source === finding.source &&
      previous.category === finding.category &&
      finding.start < previous.end
    ) {
      previous.end = Math.max(previous.end, finding.end);
      previous.confidence = Math.max(previous.confidence, finding.confidence);
      continue;
    }
    coalesced.push({ ...finding });
  }

  const prioritized = coalesced.sort(
    (left, right) =>
      Number(right.source === "recognizer") -
        Number(left.source === "recognizer") ||
      right.confidence - left.confidence ||
      left.start - right.start,
  );
  const kept: PiiFinding[] = [];

  for (const finding of prioritized) {
    if (kept.some((current) => overlapRatio(current, finding) >= 0.65)) {
      continue;
    }
    kept.push(finding);
  }
  return kept.sort((left, right) => left.start - right.start);
}

export function expandRepeatedModelFindings(
  text: string,
  findings: PiiFinding[],
) {
  const expanded = findings.map((finding) => ({ ...finding }));
  const seen = new Set(
    expanded.map(
      (finding) =>
        `${finding.start}:${finding.end}:${finding.category}:${finding.source}`,
    ),
  );

  for (const finding of findings) {
    if (finding.source !== "model") continue;
    const value = text.slice(finding.start, finding.end);
    if (
      value.trim() !== value ||
      value.length < 5 ||
      !/[\p{L}\p{N}]/u.test(value)
    ) {
      continue;
    }

    let start = text.indexOf(value);
    while (start >= 0) {
      const end = start + value.length;
      const before = start > 0 ? text[start - 1] : "";
      const after = end < text.length ? text[end] : "";
      const key = `${start}:${end}:${finding.category}:${finding.source}`;
      if (
        !/[\p{L}\p{N}]/u.test(before) &&
        !/[\p{L}\p{N}]/u.test(after) &&
        !seen.has(key)
      ) {
        expanded.push({ ...finding, start, end });
        seen.add(key);
      }
      start = text.indexOf(value, start + 1);
    }
  }

  return expanded;
}

export async function detectPii(text: string): Promise<PiiScanResult> {
  const structured = findStructuredPii(text);
  try {
    const contextual = await findContextualPii(text);
    return {
      findings: mergeFindings([
        ...structured,
        ...expandRepeatedModelFindings(text, contextual),
      ]),
      modelAvailable: true,
    };
  } catch (error) {
    return {
      findings: mergeFindings(structured),
      modelAvailable: false,
      modelError:
        error instanceof Error
          ? error.message
          : "The local PII model could not be loaded.",
    };
  }
}
