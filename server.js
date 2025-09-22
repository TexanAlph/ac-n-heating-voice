import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

const { twiml: Twiml } = twilio;
const app = express();
app.use(bodyParser.json());

/**
 * TwiML endpoint for Twilio to start media stream
 */
app.post("/twiml", (req, res) => {
  console.log("Twilio hit /twiml");
  const response = new Twiml.VoiceResponse();
  const start = response.start();
  start.stream({ url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media` });
  res.type("text/xml");
  res.send(response.toString());
});

/**
 * WebSocket server for Twilio <Stream>
 */
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio Media Stream connected");

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime");

    // Kick off conversation
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "You are Rachel, the friendly AI receptionist for AC and Heating. " +
            "Always greet warmly: 'Hi, this is Rachel with AC and Heating. How can I help you today?'. " +
            "Intake their HVAC issue (repair, maintenance, or new system install). " +
            "Then ask if there are more details. Collect contact info in order: name, phone, address. " +
            "Use natural fillers like 'mhm', 'ok got it'. Be concise and natural.",
        },
      })
    );
  });

  // Forward Twilio audio → OpenAI
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload, // Twilio already sends base64 PCM µ-law 8kHz
        })
      );
    } else if (data.event === "stop") {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  // Forward OpenAI audio → Twilio
  openaiWs.on("message", (msg) => {
    const evt = JSON.parse(msg.toString());
    if (evt.type === "response.output_audio.delta") {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: evt.delta },
        })
      );
    }
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WS closed");
    twilioWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error", err);
  });
});

/**
 * Upgrade HTTP server to handle WebSocket requests
 */
const server = app.listen(process.env.PORT || 10000, () =>
  console.log(`🚀 Server running on ${process.env.PORT || 10000}`)
);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
