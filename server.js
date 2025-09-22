// Twilio Media Streams <-> OpenAI Realtime (stable, natural pacing)
// - Waits for caller speech (server VAD) before replying
// - Sends audio back to Twilio in 20ms µ-law frames (8kHz)
// - No forced commits loop; replies only after speech_stopped
// - Greeting OFF by default (no "Please hold"); toggle GREET_FIRST to true to enable

import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const PORT  = process.env.PORT || 10000;
const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const VOICE = "alloy"; // try: verse, coral, copper if you want a different vibe
const GREET_FIRST = false; // set to true to have the AI say hello first

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- Audio helpers ----------

// µ-law encode one 16-bit PCM sample
function linearToMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// Simple linear resample PCM16 from srcRate -> dstRate
function resamplePcm16(int16Arr, srcRate, dstRate) {
  if (srcRate === dstRate) return int16Arr;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(int16Arr.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, int16Arr.length - 1);
    const frac = idx - i0;
    out[i] = (int16Arr[i0] * (1 - frac) + int16Arr[i1] * frac) | 0;
  }
  return out;
}

// Base64 PCM16LE -> Int16Array
function b64ToPcm16LE(b64) {
  const buf = Buffer.from(b64, "base64");
  const bytes = buf.byteLength & 1 ? buf.slice(0, buf.byteLength - 1) : buf;
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

// PCM16 -> µ-law bytes
function pcm16ToMulawBytes(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToMulaw(pcm16[i]);
  return out;
}

// ---------- Twilio webhook: open media stream (no greeting line) ----------
app.post("/incoming-call", (req, res) => {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const vr = new twilio.twiml.VoiceResponse();
    // No "Please hold…" line; go straight to media stream
    vr.connect().stream({ url: `wss://${host}/media-stream` });
    res.type("text/xml").send(vr.toString());
    console.log(`✅ TwiML sent (wss://${host}/media-stream)`);
  } catch (e) {
    console.error("❌ /incoming-call error:", e);
    res.type("text/xml").send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// ---------- Media stream bridge ----------
app.ws("/media-stream", (twilioWs) => {
  console.log("📞 Twilio connected: /media-stream");

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let openaiReady = false;
  let greeted = false;

  // Outbound audio pacing: send 20ms frames (8kHz * 0.02s = 160 samples -> 160 bytes µ-law)
  const OUT_FRAME_SAMPLES = 160; // 20ms @ 8kHz
  const outBuffer = []; // queue of Uint8Array chunks (µ-law)
  let paceTimer = null;

  function startPacer() {
    if (paceTimer) return;
    paceTimer = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      // Accumulate exactly 160 bytes for this frame
      let frame = new Uint8Array(OUT_FRAME_SAMPLES);
      let filled = 0;
      while (filled < OUT_FRAME_SAMPLES && outBuffer.length) {
        const chunk = outBuffer[0];
        const take = Math.min(OUT_FRAME_SAMPLES - filled, chunk.length);
        frame.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take < chunk.length) {
          outBuffer[0] = chunk.subarray(take);
        } else {
          outBuffer.shift();
        }
      }
      // If underfilled, pad with µ-law silence (0xFF)
      if (filled < OUT_FRAME_SAMPLES) {
        for (let i = filled; i < OUT_FRAME_SAMPLES; i++) frame[i] = 0xFF;
      }
      // Send one 20ms frame
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: Buffer.from(frame).toString("base64") }
      }));
    }, 20);
  }

  function stopPacer() {
    if (paceTimer) clearInterval(paceTimer);
    paceTimer = null;
  }

  // Configure Realtime session: listen first; output PCM16@16k (we'll transcode)
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "pcm16",    sample_rate: 16000 },
        turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 700 },
        instructions: "You are a friendly phone assistant. Speak naturally; wait for the caller to finish before responding."
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("🔧 session.update sent");
  };

  const maybeGreet = () => {
    if (!GREET_FIRST || greeted) return;
    greeted = true;
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Hi, this is Rachel. How can I help you today?" }
    }));
    // Optional flush
    openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
  };

  // ----- OpenAI events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    sendSessionUpdate();
    // Don't greet yet unless GREET_FIRST true & stream is ready
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) {
      console.error("❌ OpenAI message parse error:", e); return;
    }

    if (msg.type === "error") {
      console.error("❌ OpenAI error:", msg);
      return;
    }

    // Only create a response after the caller stops speaking (server VAD)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      // Ask the model to respond now
      openaiWs.send(JSON.stringify({ type: "response.create" }));
      openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
      return;
    }

    // Handle audio deltas (name can vary across previews)
    const isDelta =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta);

    if (isDelta) {
      // Decode model PCM16@16k -> resample to 8k -> µ-law -> queue for pacing
      const pcm16 = b64ToPcm16LE(msg.delta);
      const pcm8k = resamplePcm16(pcm16, 16000, 8000);
      const mulaw = pcm16ToMulawBytes(pcm8k);
      outBuffer.push(mulaw);
      return;
    }

    if (msg.type === "response.content.done") {
      // End of the model's current turn
      return;
    }
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WebSocket closed");
    stopPacer();
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  // ----- Twilio events -----
  twilioWs.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) {
      console.error("❌ Twilio message parse error:", e); return;
    }

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        console.log("▶️ Twilio stream started:", streamSid);
        startPacer();
        if (openaiReady && GREET_FIRST) maybeGreet();
        break;

      case "media":
        // Send caller audio (µ-law 8k, base64) directly to model buffer
        if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          }));
          // No manual commit loop — server VAD will decide when to respond
        }
        break;

      case "stop":
        console.log("⏹️ Twilio stream stopped");
        stopPacer();
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;

      default:
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    stopPacer();
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    stopPacer();
    try { openaiWs.close(); } catch {}
  });
});

// ---------- Start server ----------
app.listen(PORT, () => console.log(`🚀 AI receptionist running on ${PORT}`));
