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
      async ({ env, pipeline }) => {
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        env.localModelPath = "/models/";
        const wasmBackend = env.backends.onnx.wasm;
        if (!wasmBackend) {
          throw new Error("Local browser inference is unavailable.");
        }
        wasmBackend.numThreads = 1;
        wasmBackend.wasmPaths = {
          mjs: new URL(
            "/runtime/ort-wasm-simd-threaded.mjs",
            window.location.origin,
          ).href,
          wasm: new URL(
            "/runtime/ort-wasm-simd-threaded.wasm",
            window.location.origin,
          ).href,
        };
        const classifier = await pipeline(
          "token-classification",
          MODEL_ID,
          {
            dtype: "q8",
            device: "wasm",
            revision: MODEL_REVISION,
          },
        );
        return classifier as unknown as TokenClassifier;
      },
    );
  }
  return classifierPromise;
}

export function splitTextIntoChunks(text: string) {
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

function foldedTextWithOffsets(value: string) {
  let text = "";
  const offsets: number[] = [];

  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const folded = character.toLocaleLowerCase("en-US");
    for (let foldedIndex = 0; foldedIndex < folded.length; foldedIndex += 1) {
      offsets.push(index);
    }
    text += folded;
    index += character.length;
  }
  offsets.push(value.length);
  return { text, offsets };
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
  const foldedText = foldedTextWithOffsets(text);
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
      const foldedToken = token.toLocaleLowerCase("en-US");
      const foldedCursor = Math.max(
        0,
        foldedText.offsets.findIndex((offset) => offset >= cursor),
      );
      let foldedStart = foldedText.text.indexOf(foldedToken, foldedCursor);
      if (foldedStart < 0) {
        foldedStart = foldedText.text.indexOf(foldedToken);
      }
      if (foldedStart < 0) continue;
      const foldedEnd = foldedStart + foldedToken.length;
      start = foldedText.offsets[foldedStart];
      end = foldedText.offsets[foldedEnd] ?? text.length;
    }

    cursor = end as number;
    const previous = normalized[normalized.length - 1];
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

  for (const chunk of splitTextIntoChunks(text)) {
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
