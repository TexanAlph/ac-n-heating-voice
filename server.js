// server.js — Twilio Media Streams <-> OpenAI Realtime (PCMU) bridge
// Matches the Twilio tutorial’s structure and event names.
// Sources: Twilio blog + sample repo. See notes at bottom.

import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();
const { OPENAI_API_KEY, PORT } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// === Tune these safely ===
const VOICE = "alloy";                 // OpenAI voice
const MODEL = "gpt-realtime";          // Model Twilio uses in their tutorial
const TEMP = 0.6;                      // Response variability
const SERVER_PORT = Number(PORT) || 10000;

// Optional: log interesting OpenAI events
const LOG_EVENTS = new Set([
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "response.created",
  "response.output_audio.delta",
  "response.done",
  "rate_limits.updated",
  "error"
]);

const app = Fastify();
app.register(fastifyFormBody);
app.register(fastifyWs);

// Health check
app.get("/", async (_req, reply) => reply.send({ ok: true }));

// === Twilio hits this to get TwiML ===
app.all("/incoming-call", async (request, reply) => {
  // Use the same host Twilio reached us on so WSS resolves correctly behind Render/NGINX.
  const host = request.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Please hold while I connect you to our assistant.</Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Okay, you can start talking.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  reply.type("text/xml").send(twiml);
  console.log("✅ TwiML served with wss://%s/media-stream", host);
});

// === WebSocket bridge route that Twilio’s <Stream> connects to ===
app.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (twilioConn /* WebSocket */, req) => {
    console.log("📞 Twilio media stream connected");

    // 1) Connect to OpenAI Realtime
    const openai = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}&temperature=${TEMP}`,
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
      }
    );

    let streamSid = null;
    let openaiReady = false;

    // Helper: push session config to OpenAI (PCMU in/out + server VAD + instructions)
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: MODEL,
          output_modalities: ["audio"],
          audio: {
            // Twilio Media Streams are PCMU (G.711 μ-law) @ 8k
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad" } },
            output: { format: { type: "audio/pcmu" }, voice: VOICE }
          },
          instructions:
            "You are Rachel, a friendly, natural-sounding assistant. Speak clearly and conversationally."
        }
      };
      openai.send(JSON.stringify(sessionUpdate));
      if (LOG_EVENTS.has("session.updated")) console.log("→ session.update sent");
    };

    // Optional: ask the AI to speak first
    const sendInitialGreeting = () => {
      const create = {
        type: "response.create",
        response: {
          conversation: "default",
          instructions:
            "Greet the caller warmly: 'Hi, this is Rachel with AC and Heating. How can I help you today?' Keep it concise and natural."
        }
      };
      openai.send(JSON.stringify(create));
      if (LOG_EVENTS.has("response.created")) console.log("→ response.create (greeting) sent");
    };

    // 2) OpenAI WS lifecycle
    openai.on("open", () => {
      openaiReady = true;
      console.log("✅ OpenAI Realtime connected");
      // slight delay helps on some hosts
      setTimeout(() => {
        sendSessionUpdate();
        // have the AI speak first so caller hears something immediately
        setTimeout(sendInitialGreeting, 200);
      }, 250);
    });

    openai.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (LOG_EVENTS.has(msg.type)) console.log("← OpenAI:", msg.type);

        // Stream AI audio back to Twilio as PCMU frames
        if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
          // msg.delta is base64-encoded audio/pcmu
          const toTwilio = {
            event: "media",
            streamSid,
            media: { payload: msg.delta }
          };
          twilioConn.send(JSON.stringify(toTwilio));
        }

        // (Optional) could watch for response.done, etc.
      } catch (e) {
        console.error("OpenAI message parse error", e);
      }
    });

    openai.on("close", () => {
      console.log("❌ OpenAI WebSocket closed");
      try { twilioConn.close(); } catch {}
    });
    openai.on("error", (err) => console.error("OpenAI WS error:", err));

    // 3) Twilio WS lifecycle & proxy to OpenAI
    twilioConn.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log("ℹ️ Twilio start, streamSid:", streamSid);
            break;

          case "media":
            // forward PCMU payload to OpenAI input buffer
            if (openaiReady && openai.readyState === WebSocket.OPEN && data.media?.payload) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload // base64 PCMU from Twilio
              };
              openai.send(JSON.stringify(audioAppend));
            }
            break;

          case "mark":
          case "stop":
          default:
            // no-op, but helpful for debugging
            // console.log("Twilio event:", data.event);
            break;
        }
      } catch (e) {
        console.error("Twilio message parse error", e);
      }
    });

    twilioConn.on("close", () => {
      console.log("❌ Twilio WebSocket closed");
      try { openai.close(); } catch {}
    });

    twilioConn.on("error", (err) => {
      console.error("Twilio WS error:", err);
      try { openai.close(); } catch {}
    });
  });
});

// Start server
app.listen({ port: SERVER_PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 AI receptionist running on ${SERVER_PORT}`);
});

/*
NOTES / WHY THIS WORKS:
- PCMU (G.711 μ-law) is exactly what Twilio Media Streams send/expect; we configure OpenAI Realtime for audio/pcmu on both input & output.
- We rely on server_vad so we don’t need to manually commit buffers; the model speaks once it detects a turn.
- We return TwiML at /incoming-call with <Connect><Stream url="wss://${host}/media-stream"/> and we host that WS route at /media-stream.
- We push OpenAI’s response.output_audio.delta frames straight back to Twilio as media payloads (base64).
Based on Twilio’s official tutorial + sample app. */
