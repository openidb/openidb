import { Hono } from "hono";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export const transcribeRoutes = new Hono();

// POST / — transcribe audio via Groq Whisper
transcribeRoutes.post("/", async (c) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Voice transcription is not configured" }, 500);
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
    return c.json({ text: data.text || "" });
  } catch (err) {
    console.error("Transcription error:", err);
    return c.json({ error: "Transcription service unavailable" }, 502);
  }
});
