// server.js — Twilio <-> OpenAI Realtime bridge (PCMU both ways)
// Mirrors Twilio's official sample structure and events.

// Core libs
import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import WebSocket from "ws";
import dotenv from "dotenv";

// Load env
dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

// Tunables
const PORT = process.env.PORT || 10000;
const VOICE = "alloy"; // Pick any OpenAI Realtime voice you like
const TEMPERATURE = 0.5;

// Your assistant “personality” (keep it short; this runs every session)
const SYSTEM_MESSAGE =
  "You are Rachel, a calm, friendly HVAC receptionist for AC & Heating in San Antonio. " +
  "Speak naturally and concisely. Don’t interrupt the caller. If audio is unclear, briefly ask them to repeat. " +
  "Never promise arrival times; gather details and contact info.";

// Which OpenAI events to log (handy while testing)
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "response.output_audio.delta",
  "response.done",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "session.created",
  "session.updated"
];

// Fastify app
const app = Fastify({ logger: false });
app.register(fastifyFormBody);
app.register(fastifyWs);

// Health
app.get("/", async (_req, reply) => reply.send({ ok: true }));

// Twilio hits this on incoming call; we return TwiML that opens a bi-di media stream
app.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Please hold while I connect you.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  console.log("✅ TwiML sent to Twilio");
  reply.type("text/xml").send(twiml);
});

// WebSocket route Twilio will connect to for media
app.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (twilioWs /* WebSocket */, req) => {
    console.log("📞 Twilio connected to /media-stream");

    // OpenAI Realtime WS
    const openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    let streamSid = null;
    let openaiReady = false;

    // Configure the OpenAI session to use PCMU both ways and stream audio
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          output_modalities: ["audio"],
          audio: {
            // Twilio <-> us uses G.711 µ-law at 8kHz over Media Streams:
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad" } },
            output: { format: { type: "audio/pcmu" }, voice: VOICE }
          },
          instructions: SYSTEM_MESSAGE
        }
      };
      console.log("🔧 Sending session.update");
      openaiWs.send(JSON.stringify(sessionUpdate));
    };

    // Optional: have the AI speak first (uncomment to greet)
    const sendInitialConversationItem = () => {
      const greet = {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Hi, this is Rachel with AC and Heating. How can I help you today?"
        }
      };
      openaiWs.send(JSON.stringify(greet));
    };

    // ————— OpenAI WS events —————
    openaiWs.on("open", () => {
      console.log("✅ OpenAI Realtime connected");
      openaiReady = true;
      // Give the socket a beat to stabilize, then configure session
      setTimeout(() => {
        sendSessionUpdate();
        // Uncomment if you want Rachel to greet first:
        // sendInitialConversationItem();
      }, 200);
    });

    openaiWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (LOG_EVENT_TYPES.includes(msg.type)) {
          console.log("🔔 OpenAI event:", msg.type);
        }

        // Stream OpenAI audio back to Twilio as base64 PCMU "media" frames
        if (msg.type === "response.output_audio.delta" && msg.delta) {
          if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
            const frame = {
              event: "media",
              streamSid,
              media: {
                // delta is already base64-encoded PCMU from OpenAI. Twilio expects base64 payload.
                payload: Buffer.from(msg.delta, "base64").toString("base64")
              }
            };
            twilioWs.send(JSON.stringify(frame));
          }
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

    // ————— Twilio WS events —————
    twilioWs.on("message", (raw) => {
      try {
        const data = JSON.parse(raw);

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log("▶️ Twilio stream started", streamSid);
            break;

          case "media":
            // Pipe caller audio to OpenAI input buffer
            if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload // base64 PCMU from Twilio
              }));
              // Commit + request a model response (this auto-streams audio deltas back)
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              openaiWs.send(JSON.stringify({ type: "response.create" }));
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
            // Other events: ping, clear, etc.
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
});

// Start server
app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 AI receptionist running on ${PORT}`);
});
