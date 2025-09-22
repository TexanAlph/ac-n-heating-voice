// Twilio Media Streams <-> OpenAI Realtime bridge
// Hardened against the issues we saw:
// - modalities ["audio","text"]
// - PCMU (g711_ulaw, 8kHz) in/out
// - wait for Twilio streamSid + OpenAI ready before greeting
// - buffer early AI audio until streamSid exists
// - handle BOTH "response.output_audio.delta" and "response.audio.delta"
// - throttle input commits (some builds won't respond without commit)
// - explicit output flush after response.create (harmless if not needed)

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

// Try model you have access to. If one fails, swap to the other.
const MODEL = "gpt-4o-realtime-preview-2024-12-17"; // fallback: "gpt-4o-realtime-preview" or "gpt-4o-realtime"
const VOICE = "alloy"; // try: alloy, verse, coral, copper

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// 1) Twilio webhook -> TwiML that opens bi-di media to /media-stream
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
  const pendingAudio = [];

  // throttle commits (commit at most every 200ms if we appended anything)
  let appendedSinceCommit = false;
  let commitTimer = null;
  const startCommitTimer = () => {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (appendedSinceCommit && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        // After committing, request a response (for builds that require it)
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        // And explicitly flush; harmless if the build streams automatically
        openaiWs.send(JSON.stringify({ type: "response.output_audio" }));
        appendedSinceCommit = false;
      }
    }, 200);
  };

  const stopCommitTimer = () => {
    if (commitTimer) clearInterval(commitTimer);
    commitTimer = null;
  };

  // Configure session (critical: modalities must be ["audio","text"])
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
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
    // Explicit flush (ok in all builds, ignored if not needed)
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
    // Wait for Twilio 'start' (streamSid) before greeting, to avoid dropping early audio.
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }

      // Handle both possible delta names we’ve seen in the wild
      const isDelta =
        (msg.type === "response.output_audio.delta" && msg.delta) ||
        (msg.type === "response.audio.delta" && msg.delta);

      if (isDelta) {
        const delta = msg.delta; // base64 PCMU (g711_ulaw) per session settings
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: delta } }));
        } else {
          pendingAudio.push(delta);
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

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  // ----- Twilio events -----
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("▶️ Twilio stream started:", streamSid);
          flushPendingAudio();
          if (openaiReady && !greeted) sendGreeting();
          startCommitTimer();
          break;

        case "media":
          // forward caller audio (base64 PCMU) to OpenAI input buffer
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
