import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { ErrorResponse } from "../schemas/common";
import { TranscribeResponse } from "../schemas/transcribe";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const transcribe = createRoute({
  method: "post",
  path: "/",
  tags: ["Transcribe"],
  summary: "Transcribe audio via Groq Whisper",
  request: {
    body: {
      content: { "multipart/form-data": { schema: { type: "object" as const, properties: { audio: { type: "string" as const, format: "binary" } }, required: ["audio"] } } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TranscribeResponse } },
      description: "Transcribed text",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid request",
    },
    502: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Transcription service error",
    },
  },
});

export const transcribeRoutes = new OpenAPIHono();

// FormData validation is manual since Zod can't validate binary uploads
transcribeRoutes.openapi(transcribe, async (c) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Voice transcription is not configured" }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data" }, 400);
  }

  const audio = formData.get("audio");
  if (!audio || !(audio instanceof File)) {
    return c.json({ error: "Missing audio file" }, 400);
  }

  if (audio.size > MAX_FILE_SIZE) {
    return c.json({ error: "Audio file too large (max 25MB)" }, 400);
  }

  const bytes = await audio.arrayBuffer();
  const blob = new Blob([bytes], { type: audio.type || "audio/webm" });
  const fileName = audio.name || "recording.webm";

  const groqForm = new FormData();
  groqForm.append("file", blob, fileName);
  groqForm.append("model", "whisper-large-v3");
  groqForm.append("response_format", "json");
  groqForm.append("temperature", "0");

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: groqForm,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API error:", response.status, errorText);
      return c.json({ error: "Transcription service failed" }, 502);
    }

    const data = await response.json();
    return c.json({ text: data.text || "" }, 200);
  } catch (err) {
    console.error("Transcription error:", err);
    return c.json({ error: "Transcription service unavailable" }, 502);
  }
});
