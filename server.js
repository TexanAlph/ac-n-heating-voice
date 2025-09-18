import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";

// Twilio is CommonJS → import default then destructure
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Session Store (per call) =====
const SESSIONS = new Map();

function newSession(callSid) {
  return {
    id: callSid,
    lead: { name: "", phone: "", zip: "", service: "", urgency: "" },
    step: "greet"
  };
}

// ===== System Prompt for AI =====
function systemPrompt(company, city) {
  return `
You are "Rachel", a warm, concise, human receptionist for ${company} in ${city}.
Style: 1 sentence at a time, 5–12 words, never robotic.
Goals:
1. Greet: "Hi, this is Rachel with ${company}. What problem can we help you with today?"
2. Collect: name, phone, ZIP, service type, urgency.
3. Empathize briefly before each question.
4. Confirm details back before closing.
5. Close: "Thanks, [Name]. A technician will follow up shortly. We appreciate you choosing ${company}."
Hard rules:
- Never say you are AI.
- If caller asks HVAC FAQ (pricing, hours, brands, warranty), answer briefly then return to intake.
- Keep answers short, natural, professional.
`;
}

// ===== Helper: call OpenAI =====
async function askOpenAI(transcript, userLine) {
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.3,
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

// ===== Helper: TTS proxy to ElevenLabs =====
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "Hello.").toString().slice(0, 500);
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.7, similarity_boost: 0.9 }
      })
    });

    if (!r.ok) return res.status(500).send("TTS error");

    res.setHeader("Content-Type", "audio/mpeg");
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send("TTS failure");
  }
});

// ===== /voice — entry point =====
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || nanoid();
  let session = SESSIONS.get(callSid);
  if (!session) {
    session = newSession(callSid);
    SESSIONS.set(callSid, session);
  }

  const twiml = new Twiml.VoiceResponse();
  const opener = `Hi, this is Rachel with ${process.env.COMPANY_NAME || "AC-N-Heating"}. What problem can we help you with today?`;

  const sayUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", opener);

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

// ===== /gather — handle caller speech =====
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const userSaid = (req.body.SpeechResult || "").trim();

  let session = SESSIONS.get(callSid);
  if (!session) {
    session = newSession(callSid);
    SESSIONS.set(callSid, session);
  }

  const twiml = new Twiml.VoiceResponse();

  // Ask AI what to say next
  const reply = await askOpenAI([], userSaid);

  // Play reply
  const sayUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", reply);
  twiml.play(sayUrl.toString());

  // Continue gathering
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto"
  });
  g.say({ voice: "alice" }, " ");

  res.type("text/xml").send(twiml.toString());
});

// ===== Health check =====
app.get("/", (_, res) => res.send("OK"));

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT}`));
