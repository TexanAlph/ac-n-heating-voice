// Twilio Media Streams <-> OpenAI Realtime (PCMU both ways)
// Fix: session.modalities MUST be ["audio","text"]. We log exactly what we send.

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

const PORT = process.env.PORT || 10000;
const MODEL = "gpt-4o-realtime-preview-2024-12-17"; // Realtime WS
const VOICE = "alloy"; // try: alloy, verse, coral, copper

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio webhook -> return TwiML that opens a media stream to /media-stream
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

// Twilio <Stream> connects here (bi-di audio)
app.ws("/media-stream", (twilioWs, req) => {
  console.log("📞 Twilio connected: /media-stream");
  let streamSid = null;

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        // ✅ This is the critical fix:
        modalities: ["audio", "text"],
        voice: VOICE,
        // Twilio Media Streams use PCMU (G.711 μ-law) at 8kHz
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
        // Let the model handle turn-taking
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
        instructions: "You are a friendly phone assistant. Speak naturally; don’t interrupt."
      }
    };
    console.log("🔧 About to send session.update:", JSON.stringify(sessionUpdate));
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  const sendInitialGreeting = () => {
    const create = {
      type: "response.create",
      response: {
        // No need to set modalities here; inherits from session
        instructions: "Hi, this is Rachel. How can I help you today?"
      }
    };
    console.log("👋 Sending greeting response.create");
    openaiWs.send(JSON.stringify(create));
  };

  // OpenAI WS lifecycle
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    // Small delay lets Twilio stream initialize first
    setTimeout(() => {
      sendSessionUpdate();
      setTimeout(sendInitialGreeting, 150);
    }, 150);
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }

      // Stream AI audio back to Twilio as base64 PCMU
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        twilioWs.readyState === WebSocket.OPEN &&
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta }
          }));
      }

      if (msg.type === "response.content.done") {
        console.log("✅ OpenAI response content done");
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
  openaiWs.on("error", (err) => console.error("❌ OpenAI WS error:", err));

  // Twilio WS lifecycle
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
    //  console.log("→ Twilio event:", data.event); // uncomment to debug

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("▶️ Twilio stream started:", streamSid);
          break;

        case "media":
          // Forward caller audio (base64 PCMU) to OpenAI input buffer
          if (openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
            // With server VAD, no manual commit is needed each frame.
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

// Start server
app.listen(PORT, () => console.log(`🚀 AI receptionist running on ${PORT}`));
