import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import twilio from "twilio";
import dotenv from "dotenv";
import { WebSocket } from "ws";

dotenv.config();

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

const { twiml: Twiml } = twilio;

// Twilio will POST here when a call comes in
app.post("/twiml", (req, res) => {
  const response = new Twiml.VoiceResponse();

  // Start a media stream to our /media WebSocket
  response.start().stream({ url: `${process.env.RENDER_EXTERNAL_URL}/media` });

  // Say something immediately so caller hears a voice
  response.say("Hi, this is Rachel with AC and Heating. How can I help you today?");

  res.type("text/xml");
  res.send(response.toString());
});

// WebSocket endpoint for Twilio Media Streams
app.ws("/media", (ws) => {
  console.log("🔗 New Twilio media stream connected");

  ws.on("message", (msg) => {
    console.log("📨 Incoming message:", msg.toString().slice(0, 200));
    // TODO: forward audio to OpenAI Realtime and send responses back
  });

  ws.on("close", () => {
    console.log("❌ Twilio media stream closed");
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI receptionist running on port ${PORT}`);
});
