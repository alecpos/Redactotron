import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mupdfModulePath = resolve(
  projectRoot,
  "node_modules/mupdf/dist/mupdf.js",
);
const mupdfWasmWrapperPath = resolve(
  projectRoot,
  "node_modules/mupdf/dist/mupdf-wasm.js",
);

const copies = [
  [
    "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    "public/pdf.worker.min.mjs",
  ],
  [
    "node_modules/mupdf/dist/mupdf-wasm.wasm",
    "public/runtime/mupdf-wasm.wasm",
  ],
  [
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
    "public/runtime/ort-wasm-simd-threaded.mjs",
  ],
  [
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "public/runtime/ort-wasm-simd-threaded.wasm",
  ],
  [
    "node_modules/tesseract.js/dist/worker.min.js",
    "public/tesseract/worker.min.js",
  ],
  ...[
    "tesseract-core-lstm.wasm",
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ].map((filename) => [
    `node_modules/tesseract.js-core/${filename}`,
    `public/tesseract/core/${filename}`,
  ]),
  ["node_modules/mupdf/LICENSE", "public/licenses/mupdf-AGPL-3.0.txt"],
  [
    "node_modules/@huggingface/transformers/LICENSE",
    "public/licenses/transformers-apache-2.0.txt",
  ],
  ["node_modules/tesseract.js/LICENSE.md", "public/licenses/tesseract-apache-2.0.md"],
];

for (const [source, destination] of copies) {
  const sourcePath = resolve(projectRoot, source);
  const destinationPath = resolve(projectRoot, destination);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

const ortLoaderPath = resolve(
  projectRoot,
  "public/runtime/ort-wasm-simd-threaded.mjs",
);
const ortLoader = await readFile(ortLoaderPath, "utf8");
await writeFile(ortLoaderPath, ortLoader.replace(/[ \t]+$/gm, ""));

const committedAssets = new Map([
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/config.json",
    "0e4a9201c26b524b3b406dce8b2e1ccc178680775f9c579c351af1d9e3cc0ed7",
  ],
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/tokenizer.json",
    "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  ],
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/tokenizer_config.json",
    "e711904cac23112776b678356ccf702cf934babaa01125f698ac43bf9ad38e73",
  ],
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/special_tokens_map.json",
    "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
  ],
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/vocab.txt",
    "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
  ],
  [
    "public/models/onnx-community/bert-small-pii-detection-ONNX/onnx/model_quantized.onnx",
    "40e94266f077c088d3dda3e12fe7be8faa1cae862c3e3fe84b799439c509095a",
  ],
  [
    "public/tesseract/lang/eng.traineddata.gz",
    "ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468",
  ],
]);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

for (const [asset, expectedHash] of committedAssets) {
  const path = resolve(projectRoot, asset);
  await access(path);
  const actualHash = await sha256(path);
  if (actualHash !== expectedHash) {
    throw new Error(`Integrity check failed for ${asset}.`);
  }
}

await build({
  entryPoints: [
    resolve(projectRoot, "src/lib/pdf/local-redaction-worker.ts"),
  ],
  outfile: resolve(projectRoot, "public/runtime/local-redaction-worker.mjs"),
  bundle: true,
  define: {
    process: "undefined",
  },
  format: "esm",
  legalComments: "eof",
  minify: true,
  platform: "browser",
  plugins: [
    {
      name: "browser-only-mupdf",
      setup(build) {
        build.onLoad({ filter: /mupdf(?:-wasm)?\.js$/ }, async ({ path }) => {
          let source = await readFile(path, "utf8");
          if (path === mupdfModulePath) {
            const nodeLoader =
              'var node_fs = null;\nif (typeof process !== "undefined" && process.versions && process.versions.node)\n\tnode_fs = await import("node:fs");';
            if (!source.includes(nodeLoader)) {
              throw new Error("The pinned MuPDF Node loader changed.");
            }
            source = source.replace(nodeLoader, "var node_fs = null;");
          } else if (path === mupdfWasmWrapperPath) {
            const nodeLoader =
              'if(m){const{createRequire:_}=await import("module");var o=_(import.meta.url)}';
            if (!source.includes(nodeLoader)) {
              throw new Error("The pinned MuPDF WASM Node loader changed.");
            }
            source = source.replace(nodeLoader, "");
          }
          return {
            contents: source,
            loader: "js",
            resolveDir: dirname(path),
          };
        });
      },
    },
  ],
  sourcemap: false,
  target: ["es2022"],
});
