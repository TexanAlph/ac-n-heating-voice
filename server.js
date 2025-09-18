import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { twiml as Twiml, Twilio } from "twilio";
import { nanoid } from "nanoid";

/**
 * ENV VARS (set these in Render → Environment):
 *  OPENAI_API_KEY           = sk-...
 *  ELEVENLABS_API_KEY       = eleven_...
 *  ELEVENLABS_VOICE_ID      = <your ElevenLabs voice id>  (pick a realistic voice in dashboard)
 *  TWILIO_ACCOUNT_SID       = ACxxxxxxxx
 *  TWILIO_AUTH_TOKEN        = xxxxxxxxx
 *  NOTIFY_SMS_FROM          = +1210xxxxxxx   (your Twilio number)
 *  NOTIFY_SMS_TO            = +1210xxxxxxx   (your cell to receive lead summaries)
 *  COMPANY_NAME             = AC-N-Heating
 *  COMPANY_CITY             = San Antonio
 */

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Simple in-memory session store (per CallSid) ---
const SESSIONS = new Map();

/** Return a fresh session state */
function newSession(callSid) {
  return {
    id: callSid,
    createdAt: Date.now(),
    step: "greet",                    // greet -> ask_name -> ask_phone -> ask_zip -> ask_service -> ask_urgency -> confirm -> done
    lead: { name: "", phone: "", zip: "", service: "", urgency: "", notes: [] },
    transcript: [],
    faqMode: false
  };
}

/** Knowledge base: very short factual replies the agent can draw from when it detects a FAQ. Keep tight to avoid hallucinations. */
const FAQ_SNIPPETS = [
  { q: ["hours", "open"], a: "We’re available 24/7 for emergencies and same-day service most days." },
  { q: ["pricing", "cost", "charge", "how much"], a: "Diagnosis is free with repair. Standard service calls start at typical local rates; we provide exact quotes before work." },
  { q: ["brands", "brand"], a: "We service all major HVAC brands including Carrier, Trane, Lennox, Rheem, and Goodman." },
  { q: ["warranty"], a: "Parts follow manufacturer warranties; labor warranty provided on repairs and installs." },
  { q: ["financing"], a: "Yes, financing options are available on qualifying replacements and installs." },
  { q: ["maintenance", "tune", "tune-up"], a: "We offer seasonal maintenance to improve efficiency and prevent breakdowns." },
  { q: ["response", "how fast", "eta", "soon"], a: "Emergency calls are prioritized; typical arrival can be same-day within service area, depending on current demand." }
];

/** Very simple FAQ detector */
function maybeFaq(replyText) {
  const t = (replyText || "").toLowerCase();
  for (const item of FAQ_SNIPPETS) {
    if (item.q.some(key => t.includes(key))) return item.a;
  }
  return null;
}

/** Build the system prompt for OpenAI */
function systemPrompt() {
  const company = process.env.COMPANY_NAME || "AC-N-Heating";
  const city = process.env.COMPANY_CITY || "San Antonio";
  return `
You are "John", a warm, concise, human-sounding 24/7 receptionist for ${company} in ${city}.
Style: natural, 5–12 words per sentence, never robotic. No slang. No upsell. 
Primary goal: Convert callers to booked leads by collecting:
1) Full name, 2) Call-back phone, 3) ZIP or neighborhood, 4) Service type {AC repair, heating repair, install, maintenance}, 5) Urgency {emergency today vs routine}.

Greeting (always first line): "Hi, this is John with ${company}. What problem can we help you with today?"

Flow:
- Acknowledge issue with brief empathy before each question.
- Ask ONE question at a time, wait for answer.
- Repeat crucial details back briefly to confirm.
- If caller asks a general HVAC question, give a brief factual answer (1 sentence) then return to the intake flow.
- If caller gives a long story, summarize in one sentence and proceed to next question.
- If you can’t understand, politely ask to repeat.

Closing:
- Confirm details back: name, number, ZIP, service, urgency.
- Close with: "Thanks, [Name]. A technician will follow up shortly. We appreciate you choosing ${company}."

Hard rules:
- Never say you are an AI.
- Keep replies short and natural (max ~12 words).
- If caller swears or is upset, remain calm and helpful.
  `;
}

/** Ask OpenAI what to say next and what slot to fill */
async function nextAgentReply(session, userUtterance) {
  // Quick FAQ check to keep latency low
  const faq = maybeFaq(userUtterance);
  const faqHint = faq ? `The caller seems to ask a general question. Brief answer: "${faq}". Then continue intake.` : "";

  // Build a conversation trace
  const messages = [
    { role: "system", content: systemPrompt() },
  ];

  // Transcript so far:
  for (const turn of session.transcript) {
    messages.push({ role: "user", content: turn.user });
    messages.push({ role: "assistant", content: turn.agent });
  }
  if (userUtterance) messages.push({ role: "user", content: userUtterance });

  // Ask the model to output both: what to say, and which slot to fill next
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      ...messages,
      {
        role: "system",
        content:
`Your reply must be JSON with two fields:
{"say":"<what you would say to caller>","next":"one of [ask_name,ask_phone,ask_zip,ask_service,ask_urgency,confirm,done]"}
${faqHint}
If you already have a value, move to the next missing item. Keep "say" under 18 words.`
      }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  }).then(r => r.json());

  let say = "Thanks. Could you share your name?";
  let next = "ask_name";
  try {
    const text = r.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(text);
    say = parsed.say || say;
    next = parsed.next || next;
  } catch {
    // fallback
  }
  return { say, next };
}

/** Convert text to an MP3 stream via ElevenLabs and proxy it back to Twilio */
app.get("/tts", async (req, res) => {
  try {
    const text = req.query.text?.toString().slice(0, 500) || "Hello.";
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // default voice if you haven’t set one
    const er = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.7, similarity_boost: 0.9, style: 0.2, use_speaker_boost: true }
      })
    });
    if (!er.ok) {
      res.status(500).send("TTS error");
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    er.body.pipe(res);
  } catch (e) {
    res.status(500).send("TTS failure");
  }
});

/** Twilio entrypoint: greet + start the first gather */
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid || nanoid();
  const twiml = new Twiml.VoiceResponse();

  // Initialize session
  const session = newSession(callSid);
  SESSIONS.set(callSid, session);

  // Play opener from ElevenLabs, then gather speech
  const opener = `Hi, this is John with ${process.env.COMPANY_NAME || "AC-N-Heating"}. What problem can we help you with today?`;

  const sayUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", opener);

  twiml.play(sayUrl.toString());
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    hints: "air conditioner, AC repair, heater, furnace, installation, maintenance, emergency, no cool, no heat"
  });
  // Provide a silent <gather> prompt (we already played TTS)
  g.say({ voice: "alice" }, " "); // tiny filler so TwiML is valid

  res.type("text/xml").send(twiml.toString());
});

/** Handle each caller utterance, ask next question, or close */
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const session = SESSIONS.get(callSid) || newSession(callSid);
  SESSIONS.set(callSid, session);

  const userSaid = (req.body.SpeechResult || "").trim();
  if (userSaid) session.transcript.push({ user: userSaid, agent: "" });

  // Try to extract structured data opportunistically (very light extraction to keep latency down)
  await tryLightExtraction(session, userSaid);

  // Ask OpenAI what to say next
  const { say, next } = await nextAgentReply(session, userSaid);
  session.step = next;

  const twiml = new Twiml.VoiceResponse();

  // Speak reply via ElevenLabs
  const sayUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", say);
  twiml.play(sayUrl.toString());

  // If done or confirm, we either confirm then finish, or finish now
  if (next === "confirm") {
    const confirmText = confirmLine(session);
    const confirmUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
    confirmUrl.searchParams.set("text", confirmText);
    twiml.play(confirmUrl.toString());

    const g = twiml.gather({
      input: "speech",
      action: "/confirm",
      method: "POST",
      speechTimeout: "auto"
    });
    g.say({ voice: "alice" }, " ");
  } else if (next === "done") {
    await notifyAndCleanup(callSid, session);
    twiml.say({ voice: "alice" }, "Thank you. Goodbye.");
    twiml.hangup();
  } else {
    // Keep gathering
    const g = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto"
    });
    g.say({ voice: "alice" }, " ");
  }

  // Save last agent line
  const lastTurn = session.transcript[session.transcript.length - 1];
  if (lastTurn && !lastTurn.agent) lastTurn.agent = say;

  res.type("text/xml").send(twiml.toString());
});

/** Handle confirmation yes/no */
app.post("/confirm", async (req, res) => {
  const callSid = req.body.CallSid;
  const session = SESSIONS.get(callSid) || newSession(callSid);
  const userSaid = (req.body.SpeechResult || "").toLowerCase();

  const twiml = new Twiml.VoiceResponse();
  if (/(yes|correct|that.*right|sounds good)/.test(userSaid)) {
    await notifyAndCleanup(callSid, session);
    twiml.say({ voice: "alice" }, "Thanks. A technician will follow up shortly. Goodbye.");
    twiml.hangup();
  } else {
    // Ask what needs correction
    const askFix = "No problem. What should I correct—name, phone, zip, or service?";
    const sayUrl = new URL(req.protocol + "://" + req.get("host") + "/tts");
    sayUrl.searchParams.set("text", askFix);
    twiml.play(sayUrl.toString());
    const g = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto"
    });
    g.say({ voice: "alice" }, " ");
  }
  res.type("text/xml").send(twiml.toString());
});

/** Light extraction helper (fast patterns; the model still drives main flow) */
async function tryLightExtraction(session, text) {
  if (!text) return;
  const t = text.toLowerCase();

  // phone
  const phoneMatch = text.match(/(\+?1?[\s\-.]?)?(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/);
  if (phoneMatch && !session.lead.phone) session.lead.phone = phoneMatch[0];

  // zip
  const zipMatch = text.match(/\b(78\d{3}|79\d{3})\b/); // SA area common zips
  if (zipMatch && !session.lead.zip) session.lead.zip = zipMatch[0];

  // service
  if (!session.lead.service) {
    if (t.includes("ac") || t.includes("air conditioner") || t.includes("cool")) session.lead.service = "AC repair";
    else if (t.includes("heat") || t.includes("furnace")) session.lead.service = "heating repair";
    else if (t.includes("install") || t.includes("replacement")) session.lead.service = "installation";
    else if (t.includes("maint") || t.includes("tune")) session.lead.service = "maintenance";
  }

  // urgency
  if (!session.lead.urgency) {
    if (t.includes("emergency") || t.includes("asap") || t.includes("today") || t.includes("no cool") || t.includes("no heat")) session.lead.urgency = "emergency";
  }

  // name (very rough heuristic)
  if (!session.lead.name && /^my name is\s+([a-z][a-z\s.'-]{1,40})$/i.test(text.trim())) {
    session.lead.name = text.trim().replace(/^my name is/i, "").trim();
  }
}

/** Build a short confirmation line */
function confirmLine(session) {
  const L = session.lead;
  const name = L.name || "there";
  const phone = L.phone ? `, number ${L.phone}` : "";
  const zip = L.zip ? `, zip ${L.zip}` : "";
  const svc = L.service ? `, ${L.service}` : "";
  const urg = L.urgency ? `, ${L.urgency}` : "";
  return `I have ${name}${phone}${zip}${svc}${urg}. Is that correct?`;
}

/** Send SMS summary and clean session */
async function notifyAndCleanup(callSid, session) {
  try {
    const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const L = session.lead;
    const summary = [
      `Lead from ${process.env.COMPANY_NAME || "AC-N-Heating"}`,
      `Name: ${L.name || "-"}`,
      `Phone: ${L.phone || "-"}`,
      `ZIP: ${L.zip || "-"}`,
      `Service: ${L.service || "-"}`,
      `Urgency: ${L.urgency || "-"}`,
    ].join(" | ");

    if (process.env.NOTIFY_SMS_FROM && process.env.NOTIFY_SMS_TO) {
      await client.messages.create({
        from: process.env.NOTIFY_SMS_FROM,
        to: process.env.NOTIFY_SMS_TO,
        body: summary
      });
    }
  } catch (e) {
    // swallow
  } finally {
    SESSIONS.delete(callSid);
  }
}

// Health
app.get("/", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT}`));
