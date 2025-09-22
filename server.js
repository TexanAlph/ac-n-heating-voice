import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import twilio from "twilio";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

const { twiml: Twiml } = twilio;

// Twilio webhook → returns TwiML to start streaming
app.post("/twiml", (req, res) => {
  const response = new Twiml.VoiceResponse();

  // Start a stream to our /media endpoint
  response.start().stream({ url: `${process.env.RENDER_EXTERNAL_URL}/media` });

  // Greeting (caller hears immediately)
  response.say("Hi, this is Rachel with AC and Heating. How can I help you today?");

  // Prevent hangup
  response.pause({ length: 600 });

  res.type("text/xml");
  res.send(response.toString());
});

// Media stream handler
app.ws("/media", (ws, req) => {
  console.log("🔗 New Twilio media stream connected");

  // Connect to OpenAI Realtime
  const openai = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Forward Twilio audio → OpenAI
  ws.on("message", (msg) => {
    if (openai.readyState === WebSocket.OPEN) {
      openai.send(msg);
    }
  });

  // Forward OpenAI audio → Twilio
  openai.on("message", (msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio stream closed");
    openai.close();
  });

  openai.on("close", () => {
    console.log("❌ OpenAI connection closed");
    ws.close();
  });

  openai.on("error", (err) => console.error("OpenAI error:", err));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI receptionist running on ${PORT}`);
});
