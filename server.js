import express from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket from "ws";

dotenv.config();

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

const { twiml: Twiml } = twilio;

// Twilio webhook → tells Twilio to start streaming
app.post("/twiml", (req, res) => {
  const response = new Twiml.VoiceResponse();

  // Start sending audio to /media
  response.start().stream({
    url: `${process.env.RENDER_EXTERNAL_URL}/media`
  });

  // Play greeting so caller hears something immediately
  response.say("Hi, this is Rachel with AC and Heating. How can I help you today?");

  // Keep call alive
  response.pause({ length: 600 });

  res.type("text/xml");
  res.send(response.toString());
});

// Twilio <Stream> WebSocket
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

  // 🔑 Tell OpenAI to start talking right away
  openai.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");
    openai.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "You are Rachel, a friendly HVAC receptionist. Greet callers warmly, ask about their HVAC issue, and respond conversationally with audio.",
        modalities: ["audio"],
        conversation: "default",
        audio: { voice: "verse", format: "wav" }
      }
    }));
  });

  // Forward caller audio → OpenAI
  ws.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.event === "media" && openai.readyState === WebSocket.OPEN) {
      const audioData = Buffer.from(data.media.payload, "base64");

      openai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: audioData.toString("base64")
      }));

      openai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  // Forward AI audio → caller
  openai.on("message", (event) => {
    const eventString = event.toString();
    console.log("OpenAI msg:", eventString.slice(0, 200));
    try {
      const response = JSON.parse(eventString);
      if (response.type === "output_audio_buffer.append" && response.audio) {
        ws.send(JSON.stringify({
          event: "media",
          media: { payload: response.audio }
        }));
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
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
