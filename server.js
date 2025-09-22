// Express + express-ws Twilio <-> OpenAI Realtime bridge
// Streams PCMU (µ-law @ 8kHz) both directions so callers actually hear the AI.

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

// --- 1) Twilio webhook: return TwiML that opens a media stream to /media-stream
app.post("/incoming-call", (req, res) => {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const twiml = new twilio.twiml.VoiceResponse();

    // Optional: brief filler so caller hears *something* while the stream opens
    twiml.say({ voice: "alice" }, "Please hold while I connect you.");

    // Bidirectional audio bridge
    twiml.connect().stream({ url: `wss://${host}/media-stream` });

    res.type("text/xml").send(twiml.toString());
    console.log("✅ TwiML sent to Twilio");
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
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let streamSid = null;
  let openaiReady = false;

  // Configure OpenAI session for PCMU both ways + server VAD + voice
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Request audio in/out
        modalities: ["audio"],
        // Server-side voice activity detection -> model decides turns
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
        // Audio format/voice settings
        input_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000, voice: "alloy" },
        // Lightweight system guidance (optional)
        instructions:
          "You are a friendly phone assistant. Speak naturally and do not interrupt the caller. If you can't hear them, politely ask them to repeat."
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("🔧 Sent session.update (PCMU in/out, VAD, voice)");
  };

  // (Optional) Have the AI greet first. Comment out if you want the user to speak first.
  const sendInitialGreeting = () => {
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Hi, this is Rachel. How can I help you today?"
        }
      })
    );
    // No manual flush needed; Realtime streams audio deltas as they’re generated.
  };

  // ----- OpenAI WS events -----
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    openaiReady = true;
    // Give the socket a tick so downstream (Twilio) has started, then configure
    setTimeout(() => {
      sendSessionUpdate();
      // Uncomment to have Rachel greet immediately:
      // sendInitialGreeting();
    }, 120);
  });

  openaiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Audio deltas: already base64 PCMU (g711 µ-law) per session.update
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          const frame = {
            event: "media",
            streamSid,
            media: { payload: msg.delta } // pass through as-is
          };
          twilioWs.send(JSON.stringify(frame));
        }
      }

      // Useful logs while testing
      if (msg.type === "error") {
        console.error("❌ OpenAI error:", msg);
      }
      if (msg.type === "response.content.done") {
        console.log("✅ OpenAI response complete");
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
          // Forward caller audio to OpenAI (base64 PCMU)
          if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload
              })
            );
            // With server VAD enabled, the model handles turn-taking and responses.
            // No need to commit every frame.
          }
          break;

        case "mark":
          // not used
          break;

        case "stop":
          console.log("⏹️ Twilio stream stopped");
          try { openaiWs.close(); } catch {}
          try { twilioWs.close(); } catch {}
          break;

        default:
          // ignore
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
