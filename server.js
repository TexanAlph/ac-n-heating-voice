import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio client for SMS summaries
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 1. Twilio webhook → returns TwiML to start media stream
app.post("/twiml", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media" />
      </Connect>
    </Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// 2. WebSocket bridge for /media
const wss = new WebSocketServer({ noServer: true });
let activeCalls = {};

app.server = app.listen(process.env.PORT || 10000, () => {
  console.log("AI receptionist running on", process.env.PORT || 10000);
});

// Upgrade HTTP → WS
app.server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

// 3. Handle Twilio <-> OpenAI Realtime
wss.on("connection", async (ws) => {
  console.log("New Twilio media stream connected");

  // Open Realtime session
  const rt = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "verse", // natural female voice
      instructions: `
You are Rachel, the AI receptionist for AC & Heating in San Antonio.
Always sound warm, natural, and human — include fillers like “mhm,” “okay,” and pauses.

Conversation flow:
1. Greeting: “Hi, this is Rachel with AC and Heating, how can I help you today?”
2. Capture problem type (repair, maintenance, or new install). If unclear, gently clarify.
3. Ask follow-up: “Mhm, okay, got you — can you tell me a little more about that?”
4. Once problem understood, ask for NAME first, then PHONE, then ADDRESS (including ZIP).
   - Confirm each piece of info. If caller says no, politely re-ask.
5. If caller asks something random, say: “I’ll jot that down and have the tech confirm.”
6. Wrap up with natural variations: 
   - “Perfect, thanks. I’ll pass this along to our tech right away.”
   - “Got it, I’ll make sure our technician gets these details.”
7. Never hang up abruptly — end warmly.

If caller speaks unclearly, only ask once more: “Sorry, could you repeat that?” Do not loop endlessly.
      `,
    }),
  });

  const session = await rt.json();
  const openaiUrl = session.client_secret.value;
  const openaiWs = new WebSocket(openaiUrl);

  // Track call info for SMS later
  let callData = { name: null, phone: null, address: null, details: null };

  // Twilio → OpenAI
  ws.on("message", (msg) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    }
  });

  // OpenAI → Twilio
  openaiWs.on("message", (msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });

  // When call ends → SMS summary
  ws.on("close", async () => {
    console.log("Call ended, sending summary SMS...");
    let summary = `📞 New HVAC Lead\n\nIssue: ${callData.details || "Unknown"}\nName: ${callData.name || "Unknown"}\nPhone: ${callData.phone || "Unknown"}\nAddress: ${callData.address || "Unknown"}`;

    try {
      await twilioClient.messages.create({
        body: summary,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: "+12104781836", // your number
      });
      console.log("Summary sent to 210-478-1836");
    } catch (err) {
      console.error("SMS failed:", err);
    }
  });
});

export default app;
