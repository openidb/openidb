import { z } from "@hono/zod-openapi";

export const TranscribeResponse = z.object({
  text: z.string(),
}).openapi("TranscribeResponse");
