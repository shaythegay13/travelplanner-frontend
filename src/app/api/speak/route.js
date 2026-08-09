// POST /api/speak  ->  ElevenLabs text-to-speech, streamed back as audio/mpeg.
// The key stays server-side. If it is missing we return 501 and the component
// falls back to browser speech synthesis on its own — no fallback invented here.

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel, a stock ElevenLabs voice

export async function POST(request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return new Response("ELEVENLABS_API_KEY not set", { status: 501 });
  }

  let text;
  try {
    ({ text } = await request.json());
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return new Response("Body must be { text: string }", { status: 400 });
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5", // turbo for latency
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
    }
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(detail || "ElevenLabs request failed", {
      status: 502,
    });
  }

  // Stream the audio straight through rather than buffering it.
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
