import { createLocalRedactedPdf } from "@/lib/pdf/local-redaction-engine";
import type { RedactionBlock } from "@/lib/pdf/types";

type RedactionRequest = {
  id: string;
  source: ArrayBuffer;
  blocks: RedactionBlock[];
};

type RedactionWorker = typeof globalThis & {
  onmessage: ((event: MessageEvent<RedactionRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

const worker = globalThis as RedactionWorker;

worker.onmessage = async ({ data }) => {
  try {
    const output = await createLocalRedactedPdf(data.source, data.blocks);
    const transferable = new Uint8Array(output);
    worker.postMessage(
      { id: data.id, ok: true, output: transferable.buffer },
      [transferable.buffer],
    );
  } catch (caught) {
    worker.postMessage(
      {
        id: data.id,
        ok: false,
        error:
          caught instanceof Error
            ? caught.message
            : "The local PDF engine failed.",
      },
      [],
    );
  }
};
