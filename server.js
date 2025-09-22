import Fastify from "fastify";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import WebSocket from "ws";
import * as b64 from "base64-js";
import dotenv from "dotenv";

dotenv.config();

const app = Fastify();
app.register(websocket);
app.register(formbody);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RENDER_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || "localhost";
const PORT = process.env.PORT || 10000;

app.post("/twiml", async (req, reply) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({ url: `wss://${RENDER_HOST}/media` });
  reply.type("text/xml").send(twiml.toString());
  console.log("✅ TwiML sent to Twilio");
});

// Media stream handler
app.get("/media", { websocket: true }, (connection /* ws */, req) => {
  console.log("📞 Twilio connected to /media");

  // Connect to OpenAI Realtime
  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
  });

  oaWs.on("message", (msg) => {
    // Relay AI audio back to Twilio
    const data = JSON.parse(msg.toString());
    if (data.type === "response.audio.delta") {
      const audio = Buffer.from(data.delta, "base64");
      connection.send(JSON.stringify({ event: "media", media: { payload: b64.fromByteArray(audio) } }));
    }
  });

  // Incoming Twilio audio → forward to OpenAI
  connection.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "media") {
      oaWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload,
      }));
    }
  });

  connection.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    oaWs.close();
  });

  oaWs.on("close", () => {
    console.log("❌ OpenAI WebSocket closed");
  });
});

app.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`🚀 AI receptionist running on ${PORT}`);
});
