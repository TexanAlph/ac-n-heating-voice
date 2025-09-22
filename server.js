// Twilio Media Streams <-> OpenAI Realtime (PCMU 8k) bridge
// Fixes: wait for Twilio streamSid *and* OpenAI ready before greeting.
// Buffers early AI audio until streamSid exists, then flushes.
// Modalities fixed to ["audio","text"]; PCMU both ways; server VAD turn-taking.

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

const PORT   = process.env.PORT  || 10000;
const MODEL  = "gpt-4o-realtime-preview-2024-12-17";
const VOICE  = "alloy"; // try: alloy, verse, coral, copper

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

// 2) Twilio <Stream> connects here (bi-di audio)
app.ws("/media-stream", (twilioWs, req) => {
  console.log("📞 Twilio connected: /media-stream");

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let openaiReady = false;
  let greeted = false;

  // Queue any early AI audio until streamSid exists
  const pendingAudio = []; // array of base64 PCMU deltas

  // Update session: correct modalities + PCMU in/out + server VAD
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],             // <- critical: not ["audio"] alone
        voice: VOICE,
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
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

    // Some API versions require explicit flush; harmless if not needed:
    openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
  };

  const flushPendingAudio = () => {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    while (pendingAudio.length) {
      const delta = pendingAudio.shift();
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: delta } }));
    }
  };

  // ----- OpenAI events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    sendSessionUpdate();
    // Do NOT greet yet; wait for Twilio 'start' so streamSid exists.
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }

      // Stream AI audio back to Twilio as base64 PCMU
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        } else {
          // buffer until we have streamSid
          pendingAudio.push(msg.delta);
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
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  // ----- Twilio events -----
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      // console.log("→ Twilio event:", data.event);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("▶️ Twilio stream started:", streamSid);
          flushPendingAudio();
          // Greet only when BOTH sides are ready
          if (openaiReady && !greeted) sendGreeting();
          break;

        case "media":
          // Forward caller audio (base64 PCMU) to OpenAI input buffer
          if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
            // With server VAD, the model will decide when to speak (no manual commit needed).
          }
          break;

        case "stop":
          console.log("⏹️ Twilio stream stopped");
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
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    try { openaiWs.close(); } catch {}
  });
});

// 3) Start server
app.listen(PORT, () => console.log(`🚀 AI receptionist running on ${PORT}`));
