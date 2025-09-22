// Twilio Media Streams <-> OpenAI Realtime (clean, natural back-and-forth)
// - Listens first; only replies after local silence (VAD) ~700ms
// - No auto-rambling: commits only when silence & no response pending
// - OpenAI out: PCM16@16k -> resample to 8k -> µ-law -> 20ms frames to Twilio
// - Greeting OFF by default (toggle GREET_FIRST to true to enable)

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

const PORT   = process.env.PORT || 10000;
const MODEL  = "gpt-4o-realtime-preview-2024-12-17"; // swap if your key uses a different realtime model
const VOICE  = "verse"; // try: alloy, verse, coral, copper
const GREET_FIRST = false; // set true if you want a first "Hi, this is Rachel..." greeting

// ---- audio helpers ----

// µ-law decode -> Int16
function mulawToLinear(uVal) {
  const MULAW_MAX = 0x1FFF;
  const BIAS = 0x84; // 132
  uVal = ~uVal & 0xFF;
  let sign = uVal & 0x80;
  let exponent = (uVal >> 4) & 0x07;
  let mantissa = uVal & 0x0F;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= BIAS;
  if (sign !== 0) sample = -sample;
  // clamp
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// µ-law encode one Int16
function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// Base64 -> Uint8Array
function b64ToU8(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// PCM16LE base64 -> Int16Array
function b64ToPcm16LE(b64) {
  const buf = Buffer.from(b64, "base64");
  const bytes = buf.byteLength & 1 ? buf.slice(0, buf.byteLength - 1) : buf;
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
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

// PCM16 -> µ-law bytes
function pcm16ToMulawBytes(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToMulaw(pcm16[i]);
  return out;
}

// ---------- Express setup ----------
const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// 1) Twilio webhook -> open bidirectional stream (no "please hold" line)
app.post("/incoming-call", (req, res) => {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const vr = new twilio.twiml.VoiceResponse();
    vr.connect().stream({ url: `wss://${host}/media-stream` });
    res.type("text/xml").send(vr.toString());
    console.log(`✅ TwiML sent (wss://${host}/media-stream)`);
  } catch (e) {
    console.error("❌ /incoming-call error:", e);
    res.type("text/xml").send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// 2) Twilio <Stream> connects here
app.ws("/media-stream", (twilioWs) => {
  console.log("📞 Twilio connected: /media-stream");

  // OpenAI Realtime WS
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let openaiReady = false;
  let greeted = false;
  let awaitingResponse = false;

  // outbound pacing state
  const OUT_FRAME_SAMPLES = 160; // 20ms @ 8kHz
  const outQueue = []; // Uint8Array chunks (µ-law)
  let pacer = null;

  function startPacer() {
    if (pacer) return;
    pacer = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      let frame = new Uint8Array(OUT_FRAME_SAMPLES);
      let filled = 0;
      while (filled < OUT_FRAME_SAMPLES && outQueue.length) {
        const chunk = outQueue[0];
        const take = Math.min(OUT_FRAME_SAMPLES - filled, chunk.length);
        frame.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take < chunk.length) {
          outQueue[0] = chunk.subarray(take);
        } else {
          outQueue.shift();
        }
      }
      // pad with silence µ-law 0xFF
      if (filled < OUT_FRAME_SAMPLES) frame.fill(0xFF, filled);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: Buffer.from(frame).toString("base64") }
      }));
    }, 20);
  }
  function stopPacer() { if (pacer) clearInterval(pacer); pacer = null; }

  // ---- local VAD: compute RMS from incoming µ-law to detect speech vs silence ----
  const SILENCE_MS = 700;
  const RMS_THRESHOLD = 800; // adjust if too sensitive; 600-1200 typical for phone audio
  let lastSpeechAt = Date.now();
  let appendedSinceLastCommit = false;

  function updateVadFromMuLawBase64(b64) {
    const u8 = b64ToU8(b64);
    let sumSq = 0;
    const N = u8.length;
    if (N === 0) return;
    for (let i = 0; i < N; i++) {
      const s = mulawToLinear(u8[i]); // Int16
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / N);
    if (rms > RMS_THRESHOLD) {
      lastSpeechAt = Date.now();
    }
  }

  // Commit when we've been silent long enough and we appended something
  let vadTimer = null;
  function startVadTimer() {
    if (vadTimer) return;
    vadTimer = setInterval(() => {
      const now = Date.now();
      const silentFor = now - lastSpeechAt;
      if (!awaitingResponse && appendedSinceLastCommit && silentFor >= SILENCE_MS) {
        // finalize caller turn -> ask model to reply once
        appendedSinceLastCommit = false;
        awaitingResponse = true;
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        openaiWs.send(JSON.stringify({ type: "response.output_audio" })); // harmless if not required
      }
    }, 100);
  }
  function stopVadTimer() { if (vadTimer) clearInterval(vadTimer); vadTimer = null; }

  // Configure session: listen first; model out PCM16@16k; we transcode to µ-law@8k
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "pcm16",    sample_rate: 16000 },
        turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 700 },
        instructions: "You are a friendly phone assistant. Wait for the caller to finish, then reply concisely and naturally."
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
    openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
  };

  // ----- OpenAI events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    sendSessionUpdate();
    // Do not greet unless GREET_FIRST and Twilio started
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

    // Handle audio deltas: either response.output_audio.delta or response.audio.delta
    const isDelta =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta);

    if (isDelta) {
      const pcm16 = b64ToPcm16LE(msg.delta);          // PCM16 @16k
      const pcm8k = resamplePcm16(pcm16, 16000, 8000);
      const mulaw = pcm16ToMulawBytes(pcm8k);         // µ-law bytes
      outQueue.push(mulaw);                           // paced out at 20ms
      return;
    }

    if (msg.type === "response.content.done") {
      // done speaking -> allow next user turn
      awaitingResponse = false;
      return;
    }

    if (msg.type === "input_audio_buffer.speech_started") {
      // caller started -> cancel pending response gating if any
      return;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      // we also have local VAD; keep this for logging only
      return;
    }
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WebSocket closed");
    stopPacer(); stopVadTimer();
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
        startVadTimer();
        if (openaiReady && GREET_FIRST) maybeGreet();
        break;

      case "media":
        if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
          // Update local VAD from incoming µ-law
          updateVadFromMuLawBase64(data.media.payload);

          // Forward raw µ-law base64 straight to OpenAI input buffer
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          }));
          appendedSinceLastCommit = true;
        }
        break;

      case "stop":
        console.log("⏹️ Twilio stream stopped");
        stopPacer(); stopVadTimer();
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;

      default:
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    stopPacer(); stopVadTimer();
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    stopPacer(); stopVadTimer();
    try { openaiWs.close(); } catch {}
  });
});

// 3) Start server
app.listen(PORT, () => console.log(`🚀 AI receptionist running on ${PORT}`));
