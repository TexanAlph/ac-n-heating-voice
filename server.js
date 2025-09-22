import express from "express";
import bodyParser from "body-parser";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import twilio from "twilio";

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio endpoint for incoming calls
app.post("/twiml", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Start media stream to your Render server
  const connect = twiml.connect();
  connect.stream({ url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media` });

  res.type("text/xml");
  res.send(twiml.toString());
});

// WebSocket handler for Twilio <Stream>
app.ws("/media", (ws) => {
  console.log("New Twilio media stream connected");

  ws.on("message", (msg) => {
    // 🔑 This is where we’ll pipe audio to OpenAI Realtime API
    console.log("Received audio frame from Twilio");
  });

  ws.on("close", () => {
    console.log("Twilio media stream closed");
  });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
