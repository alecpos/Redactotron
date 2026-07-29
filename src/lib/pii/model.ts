import type { PiiFinding } from "@/lib/pii/types";

const MODEL_ID = "onnx-community/bert-small-pii-detection-ONNX";
const MODEL_REVISION = "6cb4e77c2b2c7f81e731b88cffa9b7a6fc675a4c";
const CHUNK_SIZE = 420;
const CHUNK_OVERLAP = 60;
const MODEL_CATEGORIES = new Set(["PERSON", "LOCATION"]);

type TokenClassificationResult = {
  entity?: string;
  entity_group?: string;
  score: number;
  start?: number;
  end?: number;
  word?: string;
};

type TokenClassifier = (
  text: string,
  options: { aggregation_strategy: "simple" },
) => Promise<TokenClassificationResult[]>;

let classifierPromise: Promise<TokenClassifier> | null = null;

type NormalizedTokenResult = {
  category: string;
  score: number;
  start: number;
  end: number;
};

async function getClassifier(): Promise<TokenClassifier> {
  if (!classifierPromise) {
    classifierPromise = import("@huggingface/transformers").then(
      async ({ pipeline }) => {
        const classifier = await pipeline(
          "token-classification",
          MODEL_ID,
          {
            dtype: "q8",
            revision: MODEL_REVISION,
          },
        );
        return classifier as unknown as TokenClassifier;
      },
    );
  }
  return classifierPromise;
}

function chunks(text: string) {
  const result: Array<{ text: string; offset: number }> = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(text.length, offset + CHUNK_SIZE);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > offset + CHUNK_SIZE / 2) end = boundary;
    }
    result.push({ text: text.slice(offset, end), offset });
    if (end === text.length) break;
    offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
  }
  return result;
}

function normalizedToken(value: string) {
  return value
    .replace(/^##/u, "")
    .replace(/^[▁Ġ]/u, "")
    .trim();
}

export function normalizeTokenResults(
  text: string,
  results: TokenClassificationResult[],
): NormalizedTokenResult[] {
  const lowerText = text.toLocaleLowerCase("en-US");
  const normalized: NormalizedTokenResult[] = [];
  let cursor = 0;

  for (const result of results) {
    const rawEntity = result.entity_group ?? result.entity ?? "";
    const category = rawEntity.replace(/^[BI]-/, "").toUpperCase();
    const prefix = rawEntity.match(/^([BI])-/u)?.[1];
    let start = result.start;
    let end = result.end;

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      (end as number) <= (start as number)
    ) {
      const token = normalizedToken(result.word ?? "");
      if (!token || token === "[UNK]") continue;
      start = lowerText.indexOf(token.toLocaleLowerCase("en-US"), cursor);
      if (start < 0) {
        start = lowerText.indexOf(token.toLocaleLowerCase("en-US"));
      }
      if (start < 0) continue;
      end = start + token.length;
    }

    cursor = end as number;
    const previous = normalized.at(-1);
    const gap =
      previous && previous.end <= (start as number)
        ? text.slice(previous.end, start as number)
        : "";
    if (
      previous &&
      prefix === "I" &&
      previous.category === category &&
      /^[\s'’-]*$/u.test(gap)
    ) {
      previous.end = end as number;
      previous.score = Math.min(previous.score, result.score);
      continue;
    }
    normalized.push({
      category,
      score: result.score,
      start: start as number,
      end: end as number,
    });
  }
  return normalized;
}

export async function findContextualPii(text: string): Promise<PiiFinding[]> {
  const classifier = await getClassifier();
  const findings: PiiFinding[] = [];

  for (const chunk of chunks(text)) {
    const results = await classifier(chunk.text, {
      aggregation_strategy: "simple",
    });
    for (const result of normalizeTokenResults(chunk.text, results)) {
      const category = result.category;
      const threshold = category === "LOCATION" ? 0.82 : 0.78;
      if (
        !MODEL_CATEGORIES.has(category) ||
        result.score < threshold ||
        result.end <= result.start
      ) {
        continue;
      }
      findings.push({
        start: chunk.offset + result.start,
        end: chunk.offset + result.end,
        category,
        confidence: result.score,
        source: "model",
      });
    }
  }
  return findings;
}
