// Minimal Twilio <-> OpenAI Realtime bridge
import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import WebSocket from "ws";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL  = "gpt-4o-realtime-preview-2024-12-17"; // realtime model
const VOICE  = "verse"; // natural voice
const PORT   = process.env.PORT || 10000;

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// 1) Twilio hits this when call comes in
app.post("/incoming-call", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const vr = new twilio.twiml.VoiceResponse();
  vr.connect().stream({ url: `wss://${host}/media-stream` });
  res.type("text/xml").send(vr.toString());
  console.log("✅ TwiML sent to Twilio");
});

// 2) Twilio stream endpoint
app.ws("/media-stream", (twilioWs) => {
  console.log("📞 Twilio connected");

  // OpenAI Realtime connection
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;

  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Configure session: bidirectional audio
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_format:  { type: "g711_ulaw", sample_rate: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000 },
        instructions: "You are a helpful phone receptionist. Start by saying: 'Hello this is XYZ, how can I help you?'"
      }
    }));

    // Trigger first response
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // Forward OpenAI → Twilio
  openaiWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "response.audio.delta" && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta }
      }));
    }
  });

  // Forward Twilio → OpenAI
  twilioWs.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.event === "start") streamSid = data.start.streamSid;
    if (data.event === "media" && data.media?.payload) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }
    if (data.event === "stop") {
      openaiWs.close();
      twilioWs.close();
    }
  });
});

// Start server
app.listen(PORT, () => console.log(`🚀 Basic AI receptionist running on ${PORT}`));
