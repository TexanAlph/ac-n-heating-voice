import express from "express";
import bodyParser from "body-parser";
import expressWs from "express-ws";
import WebSocket from "ws";
import twilio from "twilio";
import fetch from "node-fetch";

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- 1. Twilio webhook (called when someone dials your Twilio number) ---
app.post("/twiml", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Connect Twilio Media Streams to our /media WebSocket
  twiml.connect().stream({
    url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media`,
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// --- 2. Handle WebSocket between Twilio <-> OpenAI ---
app.ws("/media", (ws) => {
  console.log("📞 New Twilio Media Stream connected");

  // Connect to OpenAI Realtime API
  const openai = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // When OpenAI connection opens, configure voice + greet
  openai.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // First, configure session
    openai.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "verse", // pick a natural OpenAI voice (try: alloy, verse, coral, sage)
        modalities: ["audio"],
        input_audio_format: { type: "pcm16", sample_rate: 8000 },
        output_audio_format: { type: "pcm16", sample_rate: 8000 }
      }
    }));

    // Then, send greeting
    openai.send(JSON.stringify({
      type: "response.create",
      response: {
        conversation: "default",
        modalities: ["audio"],
        instructions: "Hi, this is Rachel with AC and Heating. How can I help you today?"
      }
    }));
  });

  // Handle messages from OpenAI
  openai.on("message", (event) => {
    const msg = JSON.parse(event.toString());

    if (msg.type === "input_audio_buffer.speech_started") {
      console.log("🚀 Caller started speaking");
    }

    if (msg.type === "response.output_audio_buffer.append") {
      console.log("🗣️ AI speaking, sending audio back to Twilio");
      ws.send(JSON.stringify({
        event: "media",
        media: { payload: msg.audio }
      }));
    }

    if (msg.type === "response.output_text.delta") {
      console.log("📝 Partial transcript:", msg.delta);
    }

    if (msg.type === "response.content.done") {
      console.log("✅ Response finished");
    }
  });

  // Forward audio from Twilio → OpenAI
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.event === "media") {
      // Send audio chunks to OpenAI
      openai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }

    if (data.event === "stop") {
      console.log("⏹️ Call ended, committing audio buffer");
      openai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  // Error handling
  openai.on("error", (err) => console.error("❌ OpenAI error:", err));
  ws.on("close", () => console.log("❌ Twilio WS closed"));
});

// --- Start Server ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`🚀 AI receptionist running on ${port}`));
