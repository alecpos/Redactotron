import { z } from "zod";

const finite = z.number().finite();

export const pdfRectSchema = z
  .object({
    x0: finite,
    y0: finite,
    x1: finite,
    y1: finite,
  })
  .refine((rect) => rect.x1 > rect.x0 && rect.y1 > rect.y0, {
    message: "Redaction rectangles must have positive area.",
  });

export const redactionBlockSchema = z.object({
  id: z.string().min(1).max(80),
  pageIndex: z.number().int().min(0).max(99),
  rects: z.array(pdfRectSchema).min(1).max(100),
  labelRectIndex: z.number().int().min(0),
  replacement: z.literal("REDACTED"),
  appearance: z.literal("text-replacement"),
});

export const redactionManifestSchema = z.object({
  blocks: z.array(redactionBlockSchema).min(1).max(200),
});
