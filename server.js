import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket from "ws";
import * as base64 from "base64-js";

dotenv.config();

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

const { twiml: Twiml } = twilio;

// Twilio webhook → tells Twilio to start streaming
app.post("/twiml", (req, res) => {
  const response = new Twiml.VoiceResponse();

  response.start().stream({
    url: `${process.env.RENDER_EXTERNAL_URL}/media`
  });

  response.say("Hi, this is Rachel with AC and Heating. How can I help you today?");
  response.pause({ length: 600 }); // keep call alive

  res.type("text/xml");
  res.send(response.toString());
});

// Handle Twilio <Stream> WebSocket
app.ws("/media", (ws) => {
  console.log("🔗 Twilio media stream connected");

  // Connect to OpenAI Realtime
  const openai = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // When Twilio sends audio
  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.event === "media" && openai.readyState === WebSocket.OPEN) {
      // Decode base64 PCM from Twilio
      const audioData = base64.toByteArray(data.media.payload);

      // Send to OpenAI as input buffer
      openai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: audioData.toString("base64")
      }));

      // Commit after each chunk
      openai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      // Create a new response
      openai.send(JSON.stringify({ type: "response.create" }));
    }
  });

  // When OpenAI sends audio back
  openai.on("message", (event) => {
    const response = JSON.parse(event.toString());

    if (response.type === "output_audio_buffer.append" && response.audio) {
      // Send audio back to Twilio
      ws.send(JSON.stringify({
        event: "media",
        media: { payload: response.audio }
      }));
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio stream closed");
    openai.close();
  });

  openai.on("close", () => {
    console.log("❌ OpenAI closed");
    ws.close();
  });

  openai.on("error", (err) => console.error("OpenAI error:", err));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI receptionist running on port ${PORT}`);
});
