// Express + express-ws Twilio <-> OpenAI Realtime bridge
// FIXED: session.update uses modalities ["audio","text"] and proper *_audio_format fields.

import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const PORT = process.env.PORT || 10000;
const MODEL = "gpt-4o-realtime-preview-2024-12-17"; // works with Realtime WS
const VOICE = "alloy"; // try: alloy, verse, copper, coral, etc.

// --- 1) Twilio webhook: return TwiML that opens a media stream to /media-stream
app.post("/incoming-call", (req, res) => {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const twiml = new twilio.twiml.VoiceResponse();

    twiml.say({ voice: "alice" }, "Please hold while I connect you.");
    // Bidirectional audio bridge to our WS
    twiml.connect().stream({ url: `wss://${host}/media-stream` });

    res.type("text/xml").send(twiml.toString());
    console.log("✅ TwiML sent to Twilio (wss://%s/media-stream)", host);
  } catch (err) {
    console.error("❌ /incoming-call error:", err);
    res
      .type("text/xml")
      .send(`<Response><Say>Sorry, something went wrong.</Say></Response>`);
  }
});

// --- 2) WebSocket endpoint Twilio will stream to
app.ws("/media-stream", (twilioWs, req) => {
  console.log("📞 Twilio connected: /media-stream");

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let streamSid = null;
  let openaiReady = false;

  // Correct session.update: modalities MUST be ["audio","text"] (not ["audio"]).
  // Use proper input/output audio format fields + server-side VAD.
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        // REQUIRED: Realtime only supports ["text"] or ["audio","text"]
        modalities: ["audio", "text"],
        // voice + PCMU in/out at 8 kHz
        voice: VOICE,
        input_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
        // Let the model handle turn-taking
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
        // Light guidance
        instructions:
          "You are a friendly phone assistant. Speak naturally and do not interrupt the caller. If audio is unclear, politely ask for a repeat."
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("🔧 Sent session.update (modalities audio+text, PCMU in/out, VAD, voice)");
  };

  // Optional: greet first so caller hears something quickly
  const sendInitialGreeting = () => {
    const create = {
      type: "response.create",
      response: {
        modalities: ["audio"], // per-session allows audio streaming
        instructions: "Hi, this is Rachel. How can I help you today?"
      }
    };
    openaiWs.send(JSON.stringify(create));
    console.log("👋 Sent initial greeting");
  };

  // ----- OpenAI WS events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    setTimeout(() => {
      sendSessionUpdate();
      setTimeout(sendInitialGreeting, 150);
    }, 150);
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }

      // Stream AI audio back to Twilio as PCMU frames
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        // msg.delta is base64-encoded g711_ulaw by our session settings
        const frame = {
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        };
        twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(frame));
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

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  // ----- Twilio WS events -----
  twilioWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("▶️ Twilio stream started:", streamSid);
          break;

        case "media":
          // Forward caller audio (base64 PCMU) to OpenAI input buffer
          if (openaiReady && openaiWs.readyState === WebSocket.OPEN && data.media?.payload) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload
              })
            );
            // With server VAD enabled, model handles commit/turns automatically.
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

// --- 3) Start server
app.listen(PORT, () => {
  console.log(`🚀 AI receptionist running on ${PORT}`);
});
