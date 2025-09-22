// Twilio Media Streams <-> OpenAI Realtime bridge, with guaranteed clean audio back to Twilio.
// Strategy: request PCM16@16k from OpenAI, resample to 8k and encode to G.711 µ-law, then send to Twilio.
// Also gates greeting until Twilio streamSid exists, buffers early audio, throttles commits, and handles event name variants.

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
const MODEL = "gpt-4o-realtime-preview-2024-12-17"; // swap if needed
const VOICE = "alloy"; // alloy | verse | coral | copper etc.

// ---- PCM16 <-> µ-law helpers ----

// µ-law encoder (G.711). Input: Int16 sample, Output: 8-bit µ-law byte
function linearToMulaw(sample) {
  const BIAS = 0x84;          // 132
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulaw;
}

// Downsample PCM16 from srcRate to dstRate with simple linear interpolation (good enough for voice)
function resamplePcm16(int16Arr, srcRate, dstRate) {
  if (srcRate === dstRate) return int16Arr;
  const ratio = srcRate / dstRate;
  const newLen = Math.floor(int16Arr.length / ratio);
  const out = new Int16Array(newLen);
  let pos = 0;
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, int16Arr.length - 1);
    const frac = idx - i0;
    out[i] = (int16Arr[i0] * (1 - frac) + int16Arr[i1] * frac) | 0;
    pos += ratio;
  }
  return out;
}

// PCM16 Int16Array -> µ-law Uint8Array
function pcm16ToMulawBytes(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToMulaw(pcm16[i]);
  return out;
}

// Base64 PCM16LE -> Int16Array
function b64ToPcm16LE(b64) {
  const buf = Buffer.from(b64, "base64");
  // Ensure even length
  const bytes = buf.byteLength & 1 ? buf.slice(0, buf.byteLength - 1) : buf;
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// 1) Twilio webhook -> TwiML that opens a bidirectional media stream
app.post("/incoming-call", (req, res) => {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const vr = new twilio.twiml.VoiceResponse();
    vr.say({ voice: "alice" }, "Please hold while I connect you.");
    vr.connect().stream({ url: `wss://${host}/media-stream` });
    res.type("text/xml").send(vr.toString());
    console.log(`✅ TwiML sent (wss://${host}/media-stream)`);
  } catch (e) {
    console.error("❌ /incoming-call error:", e);
    res.type("text/xml").send(`<Response><Say>Application error.</Say></Response>`);
  }
});

// 2) Twilio <Stream> connects here
app.ws("/media-stream", (twilioWs, req) => {
  console.log("📞 Twilio connected: /media-stream");

  // OpenAI Realtime WS
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let openaiReady = false;
  let greeted = false;

  // buffer AI audio until streamSid exists
  const pendingMuLaw = [];

  // throttle commits (commit at most every 200ms if anything appended)
  let appendedSinceCommit = false;
  let commitTimer = null;
  const startCommitTimer = () => {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (appendedSinceCommit && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
        appendedSinceCommit = false;
      }
    }, 200);
  };
  const stopCommitTimer = () => { if (commitTimer) clearInterval(commitTimer); commitTimer = null; };

  // Configure session: modalities audio+text, input PCMU (8k), output PCM16 (16k) -> we will transcode to PCMU 8k
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "pcm16",    sample_rate: 16000 },
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
        instructions: "You are a friendly phone assistant. Speak naturally; do not interrupt."
      }
    };
    console.log("🔧 session.update ->", JSON.stringify(sessionUpdate));
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  const sendGreeting = () => {
    if (greeted) return;
    greeted = true;
    const create = {
      type: "response.create",
      response: { instructions: "Hi, this is Rachel. How can I help you today?" }
    };
    console.log("👋 response.create (greeting)");
    openaiWs.send(JSON.stringify(create));
    openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
  };

  const flushPending = () => {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    while (pendingMuLaw.length) {
      const payload = pendingMuLaw.shift();
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    }
  };

  // ----- OpenAI events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    sendSessionUpdate();
    // wait for Twilio stream 'start' before greeting
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }

      // Some builds use "response.output_audio.delta", others "response.audio.delta"
      const isDelta =
        (msg.type === "response.output_audio.delta" && msg.delta) ||
        (msg.type === "response.audio.delta" && msg.delta);

      if (isDelta) {
        // msg.delta is base64 PCM16@16k per our session settings
        const pcm16 = b64ToPcm16LE(msg.delta);
        const pcm8k = resamplePcm16(pcm16, 16000, 8000);
        const muLaw = pcm16ToMulawBytes(pcm8k);
        const b64 = Buffer.from(muLaw).toString("base64");

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        } else {
          pendingMuLaw.push(b64);
        }
      }

      if (msg.type === "response.content.done") {
        console.log("✅ OpenAI response done");
      }
      if (msg.type === "input_audio_buffer.speech_started") {
        console.log("🎙️ Caller started speaking");
      }
      if (msg.type === "input_audio_buffer.speech_stopped") {
        console.log("🛑 Caller stopped speaking");
      }
    } catch (e) {
      console.error("❌ OpenAI message parse error:", e);
    }
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WebSocket closed");
    stopCommitTimer();
    try { twilioWs.close(); } catch {}
  });
  openaiWs.on("error", (err) => console.error("❌ OpenAI WS error:", err));

  // ----- Twilio events -----
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("▶️ Twilio stream started:", streamSid);
          flushPending();
          if (openaiReady && !greeted) sendGreeting();
          startCommitTimer();
          break;

        case "media":
          // forward caller audio (base64 PCMU 8k) to OpenAI input buffer
          if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
            appendedSinceCommit = true;
          }
          break;

        case "stop":
          console.log("⏹️ Twilio stream stopped");
          stopCommitTimer();
          try { openaiWs.close(); } catch {}
          try { twilioWs.close(); } catch {}
          break;

        default:
          break;
      }
    } catch (e) {
      console.error("❌ Twilio message parse error:", e);
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    stopCommitTimer();
    try { openaiWs.close(); } catch {}
  });
  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    stopCommitTimer();
    try { openaiWs.close(); } catch {}
  });
});

// 3) Start server
app.listen(PORT, () => console.log(`🚀 AI receptionist running on ${PORT}`));
