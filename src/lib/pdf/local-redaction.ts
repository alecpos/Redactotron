import type { RedactionBlock } from "@/lib/pdf/types";
import { createBrowserId } from "@/lib/browser-compat";

type WorkerResponse =
  | {
      id: string;
      ok: true;
      output: ArrayBuffer;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export function createLocalRedactedPdf(
  source: ArrayBuffer,
  blocks: RedactionBlock[],
): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/runtime/local-redaction-worker.mjs", {
      type: "module",
      name: "redactotron-pdf-export",
    });
    const id = createBrowserId();

    const finish = () => worker.terminate();

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.ok) {
        resolve(new Uint8Array(event.data.output));
      } else {
        reject(new Error(event.data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      finish();
      reject(new Error(event.message || "The local PDF engine failed."));
    });
    worker.postMessage({ id, source, blocks }, [source]);
  });
}
