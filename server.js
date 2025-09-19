// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import pkg from "twilio";

const { twiml: Twiml, Twilio } = pkg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Load env variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // replace with your chosen ElevenLabs v3 voice ID
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TO_SMS = "+12104781836"; // Your number
const FROM_SMS = process.env.TWILIO_NUMBER; // Your Twilio number

const twilioClient = new Twilio(TWILIO_SID, TWILIO_AUTH);

// Conversation state tracker
const sessions = {};

// System prompt (Rachel’s script)
const SYSTEM_PROMPT = `
You are Rachel, a friendly AI receptionist for AC & Heating.
Your job is to intake caller details naturally. Stay conversational, not robotic.
Follow this flow:

1. Greeting:
"Hi, this is Rachel with AC and Heating, how can I help you today?"

2. Problem Intake:
- Listen, then acknowledge with a random variation:
  - "Mhm, okay, I got you."
  - "Alright, I hear you."
  - "Got it, thanks for letting me know."
  - "Yeah, that makes sense."
- Classify into repair, maintenance, install, or other.
- For random questions say:
  - "I’m not sure about that, but I’ll make sure the tech finds out for you."
  - "Good question — I’ll jot that down and have the office confirm when they call you back."

3. Intake order:
- Name → Phone → Address → ZIP
- Confirm all details back
- Close with one variation:
  - "Perfect, I’ve got everything noted. Dispatch will call you shortly."
  - "Okay, thanks [NAME], I’ve passed this along and someone will follow up soon."
  - "Alright, I’ll make sure the office has this info. We’ll be in touch shortly."

Rules:
- Never loop endlessly. Retry max 2 times, then move on.
- Do not give pricing or financing info.
- Be empathetic if caller upset.
- Use fillers like "mhm" or "okay" to sound human.
`;

// Endpoint: Voice webhook
app.post("/voice", async (req, res) => {
  const twiml = new Twiml.VoiceResponse();

  // Start conversation
  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say("Hi, this is Rachel with AC and Heating, how can I help you today?", { voice: "alice" });
  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle gathered speech
app.post("/gather", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const callSid = req.body.CallSid;

  if (!sessions[callSid]) {
    sessions[callSid] = { history: [] };
  }

  sessions[callSid].history.push({ role: "user", content: userSpeech });

  // Send to OpenAI
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...sessions[callSid].history
      ]
    })
  });

  const data = await response.json();
  const aiReply = data.choices?.[0]?.message?.content || "Okay.";

  sessions[callSid].history.push({ role: "assistant", content: aiReply });

  // Convert AI reply to voice with ElevenLabs
  const audioResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: aiReply,
      voice_settings: { stability: 0.4, similarity_boost: 0.9 },
      model_id: "eleven_multilingual_v3"
    })
  });

  const twiml = new Twiml.VoiceResponse();
  if (audioResp.ok) {
    // Save mp3 temporarily in streaming scenario; for demo, use <Say>
    twiml.say(aiReply, { voice: "alice" });
    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto"
    });
    gather.say(" ", { voice: "alice" });
  } else {
    twiml.say("Sorry, something went wrong. I’ll make sure the office gets your message.", { voice: "alice" });
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// End of call: send summary SMS
app.post("/end", async (req, res) => {
  const callSid = req.body.CallSid;
  const history = sessions[callSid]?.history || [];

  const summary = history.map(h => `${h.role}: ${h.content}`).join("\n");

  try {
    await twilioClient.messages.create({
      body: `New HVAC Call Intake:\n${summary}`,
      from: FROM_SMS,
      to: TO_SMS
    });
  } catch (err) {
    console.error("SMS failed:", err);
  }

  res.sendStatus(200);
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI receptionist running on ${PORT}`);
});
