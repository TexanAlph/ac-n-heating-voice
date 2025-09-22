import express from "express";
import bodyParser from "body-parser";
import expressWs from "express-ws";
import { WebSocket } from "ws";
import twilio from "twilio";

const app = express();
expressWs(app);
app.use(bodyParser.urlencoded({ extended: false }));

// ---------- TwiML route ----------
app.post("/twiml", (req, res) => {
  try {
    const vr = new twilio.twiml.VoiceResponse();
    vr.connect().stream({
      url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media`
    });
    res.type("text/xml").send(vr.toString());
    console.log("✅ TwiML sent to Twilio");
  } catch (err) {
    console.error("❌ Error in /twiml:", err);
    res
      .type("text/xml")
      .send(`<Response><Say>Sorry, something went wrong.</Say></Response>`);
  }
});

// ---------- Media stream route ----------
app.ws("/media", (twilioWs, req) => {
  console.log("📞 Twilio connected to /media");

  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // When OpenAI connection is open, send greeting + flush
  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Step 1: Create response (the greeting)
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Hi, this is Rachel with AC and Heating. How can I help you today?"
        }
      })
    );

    // Step 2: Flush the audio so Twilio hears it
    openaiWs.send(
      JSON.stringify({
        type: "response.output_audio"
      })
    );
  });

  // Handle OpenAI messages
  openaiWs.on("message", (msg) => {
    const event = JSON.parse(msg.toString());

    if (event.type === "output_audio_buffer.append") {
      // Relay audio back to Twilio
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: event.audio }
        })
      );
    }

    if (event.type === "output_audio_buffer.commit") {
      twilioWs.send(
        JSON.stringify({
          event: "mark",
          mark: { name: "commit" }
        })
      );
    }

    if (event.type === "response.message") {
      console.log("💬 OpenAI text:", event.message?.content?.[0]?.text || "");
    }
  });

  // Handle Twilio -> OpenAI
  twilioWs.on("message", (msg) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WebSocket closed");
  });
});

// ---------- Start server ----------
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 AI receptionist running on ${port}`);
});
