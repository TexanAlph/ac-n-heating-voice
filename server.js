import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

const { twiml: Twiml } = twilio;

const app = express();
app.use(bodyParser.json());

/**
 * TwiML endpoint: when a call comes in, Twilio hits this first.
 * It tells Twilio to open a Media Stream to our /media endpoint.
 */
app.post("/twiml", (req, res) => {
  console.log("Twilio requested /twiml");
  const response = new Twiml.VoiceResponse();
  const start = response.start();
  start.stream({ url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media` });
  res.type("text/xml");
  res.send(response.toString());
});

app.get("/health", (req, res) => {
  res.type("text/plain");
  res.send("OK");
});

let openaiWs = null;

/**
 * Twilio Media Stream WebSocket handler
 */
const server = createServer(app);

app.ws = function (path, handler) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { url } = req;
    if (!url) {
      socket.destroy();
      return;
    }

    const pathname = new URL(url, `http://${req.headers.host}`).pathname;

    if (pathname === path) {
      wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
    }
  });
};

app.ws("/media", (twilioWs) => {
  console.log("Twilio connected");

  // Connect to OpenAI Realtime
  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI connected");

    // Kick off conversation
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "You are Rachel, the friendly AI receptionist for AC and Heating. Always greet warmly: 'Hi, this is Rachel with AC and Heating. How can I help you today?' Intake their HVAC issue (repair, maintenance, or new system install). Then ask for more details if needed. Collect contact info in order: name, phone, address. Use natural fillers like 'mhm', 'ok got it'. If they ask random HVAC questions, say you're not sure but a tech will confirm. If outside scope, politely redirect back to intake. Be concise and natural.",
        },
      })
    );
  });

  // Forward Twilio audio → OpenAI
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      const audioB64 = data.media.payload;
      openaiWs?.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: audioB64,
        })
      );
      console.log("Audio forwarded to OpenAI");
    } else if (data.event === "stop") {
      openaiWs?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  // Forward OpenAI audio → Twilio
  openaiWs.on("message", (msg) => {
    const evt = JSON.parse(msg.toString());
    if (evt.type === "response.output_audio.delta") {
      const audioB64 = evt.delta;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: audioB64 },
        })
      );
      console.log("Audio received from OpenAI");
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
    twilioWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error", err);
    twilioWs.send(
      JSON.stringify({
        event: "media",
        media: {
          payload: Buffer.from(
            "Sorry, something went wrong, please call again later."
          ).toString("base64"),
        },
      })
    );
  });
});

const port = process.env.PORT || 10000;
server.listen(port, () => console.log(`AI receptionist running on ${port}`));
