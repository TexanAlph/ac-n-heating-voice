import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";

// Twilio (CommonJS style → import default then destructure)
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Session Store (per caller) =====
const SESSIONS = new Map();

function newSession(callerId) {
  return {
    id: callerId,
    lead: { name: "", phone: "", zip: "", service: "", urgency: "" },
    transcript: [],
    step: "greet"
  };
}

// ===== System Prompt for AI =====
function systemPrompt(company, city) {
  return `
You are "Rachel", a warm, natural-sounding receptionist for ${company} in ${city}.
Goals:
1. Greet politely and empathetically.
2. Collect details: name, phone, ZIP code, service type (AC repair, heating, install, maintenance, emergency), and urgency.
3. Always confirm details back before moving on.
4. Keep replies SHORT (5–12 words). Sound conversational, human, never robotic.
5. If caller asks HVAC FAQs (pricing, brands, warranty), answer briefly, then return to intake.
6. Close with: "Thanks [Name], a technician will call you shortly. We appreciate you choosing ${company}."
Rules:
- Never say you are AI.
- Speak naturally, one short sentence at a time.
- Prioritize capturing lead info completely.
`;
}

// ===== OpenAI Helper =====
async function askOpenAI(transcript, userLine) {
  const payload = {
    model: "gpt-4o-mini", // fast & natural
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt(process.env.COMPANY_NAME || "AC-N-Heating", process.env.COMPANY_CITY || "San Antonio") },
      ...transcript,
      { role: "user", content: userLine }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });

  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || "Could you repeat that, please?";
}

// ===== ElevenLabs TTS Proxy =====
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "Hello.").toString().slice(0, 500);
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.95,
          style: 0.6,
          use_speaker_boost: true
        }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("ElevenLabs API Error:", r.status, errText);
      return res.status(500).send(`TTS error: ${r.status} ${errText}`);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    r.body.pipe(res);

  } catch (e) {
    console.error("TTS exception:", e);
    res.status(500).send("TTS failure");
  }
});

// ===== /voice — Call Entry Point =====
app.post("/voice", (req, res) => {
  const callerId = req.body.From || nanoid();
  let session = SESSIONS.get(callerId);
  if (!session) {
    session = newSession(callerId);
    SESSIONS.set(callerId, session);
  }

  const twiml = new Twiml.VoiceResponse();

  if (session.step === "greet") {
    const opener = `Hi, this is Rachel with ${process.env.COMPANY_NAME || "AC-N-Heating"}. What problem can we help you with today?`;
    const sayUrl = new URL("https://" + req.get("host") + "/tts");
    sayUrl.searchParams.set("text", opener);
    twiml.play(sayUrl.toString());
    session.transcript.push({ role: "assistant", content: opener });
    session.step = "intake";
  }

  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto"
  });
  g.say({ voice: "alice" }, " "); // filler to keep gather active

  res.type("text/xml").send(twiml.toString());
});

// ===== /gather — Process Caller Response =====
app.post("/gather", async (req, res) => {
  const callerId = req.body.From || nanoid();
  let session = SESSIONS.get(callerId);
  if (!session) {
    session = newSession(callerId);
    SESSIONS.set(callerId, session);
  }

  const userSaid = (req.body.SpeechResult || "").trim();
  session.transcript.push({ role: "user", content: userSaid });

  // Get AI reply
  const reply = await askOpenAI(session.transcript, userSaid);
  session.transcript.push({ role: "assistant", content: reply });

  // Very naive lead capture (can refine with regex or OpenAI classification)
  if (userSaid.match(/\d{5}/)) session.lead.zip = userSaid.match(/\d{5}/)[0];
  if (userSaid.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)) session.lead.phone = userSaid.match(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/)[0];

  // If lead info is complete → send SMS
  if (session.lead.name && session.lead.phone && session.lead.zip && session.lead.service && session.step !== "done") {
    try {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      await client.messages.create({
        body: `New HVAC lead: ${JSON.stringify(session.lead)}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ALERT_PHONE_NUMBER
      });
      console.log("Lead SMS sent:", session.lead);
      session.step = "done";
    } catch (err) {
      console.error("SMS error:", err);
    }
  }

  const twiml = new Twiml.VoiceResponse();
  const sayUrl = new URL("https://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", reply);
  twiml.play(sayUrl.toString());

  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto"
  });
  g.say({ voice: "alice" }, " ");

  res.type("text/xml").send(twiml.toString());
});

// ===== Health Check =====
app.get("/", (_, res) => res.send("OK"));

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT}`));
