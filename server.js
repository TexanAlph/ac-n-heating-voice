import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";

// Twilio (CommonJS packaged) → import default then destructure
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config / Knowledge (embed your site content here) ----------
const COMPANY_NAME = process.env.COMPANY_NAME || "AC and Heating";
const COMPANY_CITY = process.env.COMPANY_CITY || "San Antonio";
const COMPANY_MARKET = "residential HVAC (with occasional light commercial)";
const BUSINESS_HOURS = { start: 8, end: 18, tz: "America/Chicago" }; // 8am–6pm CT

// Services you offer on site (adjust text if needed)
const SERVICES = [
  "AC Repair",
  "Heating Repair",
  "New System Installation",
  "Maintenance/Tune-Up",
  "Ductless Mini-Split Service",
  "Thermostat Install/Repair",
  "24/7 Emergency Service"
];

// Primary service areas (tight list for on-call clarity)
const SERVICE_AREAS = [
  "San Antonio",
  "Alamo Heights",
  "Stone Oak",
  "Helotes",
  "Leon Valley",
  "Shavano Park",
  "Converse",
  "Universal City",
  "Schertz",
  "Cibolo",
  "Selma",
  "Live Oak",
  "New Braunfels",
  "Boerne"
];

// Policies you want the CSR to follow (matches your site & expectations)
const POLICIES = {
  pricingStyle: "Technician diagnoses first, then provides clear quote before work.",
  warranties: "Manufacturer parts warranties; labor warranty provided on repairs/installs.",
  brands: "We service all major brands: Carrier, Trane, Lennox, Rheem, Goodman, etc.",
  licensing: "Licensed and insured.",
  financing: "Financing options available on qualifying replacements/installs.",
  dispatch: "Never promise exact ETA on phone; dispatcher/tech will confirm.",
  timingGeneral: "Most visits run about 45–90 minutes, depending on the issue.",
  afterHours: "We triage after-hours calls; on-call tech/dispatcher confirms ETA."
};

// ---------- Utilities ----------
function isAfterHours() {
  try {
    const now = new Date();
    const ctString = now.toLocaleString("en-US", { timeZone: BUSINESS_HOURS.tz, hour12: false });
    // ctString like "9/18/2025, 21:05:12" → get hour
    const hour = parseInt(ctString.split(",")[1].trim().split(":")[0], 10);
    return hour < BUSINESS_HOURS.start || hour >= BUSINESS_HOURS.end;
  } catch {
    // Fallback if TZ parsing fails
    const hour = new Date().getHours();
    return hour < 8 || hour >= 18;
  }
}

// Persist sessions by caller phone so redials resume
const SESSIONS = new Map();
function getSession(callerId) {
  let s = SESSIONS.get(callerId);
  if (!s) {
    s = {
      id: callerId,
      lead: { name: "", phone: "", zip: "", service: "", address: "" },
      transcript: [],
      turns: 0,
      step: "greet"
    };
    SESSIONS.set(callerId, s);
  }
  return s;
}

// ---------- System Prompt (all behavior + site knowledge baked in) ----------
function systemPrompt() {
  const afterHoursNow = isAfterHours() ? "yes" : "no";
  return `
You are "Rachel", a warm, human-sounding receptionist for ${COMPANY_NAME} in ${COMPANY_CITY}.
You sound like a real person: short sentences (5–12 words), varied phrasing, natural pauses.
Use light backchannels where appropriate: ["mhmm", "okay", "got it", "alright", "one sec"].
Never say you're an AI. Never over-promise. Never give exact ETAs or prices.

Company quick facts:
- Market: ${COMPANY_MARKET}
- Services: ${SERVICES.join(", ")}.
- Areas: ${SERVICE_AREAS.join(", ")}.
- Policies: ${POLICIES.pricingStyle} ${POLICIES.warranties}
  Brands: ${POLICIES.brands} Licensing: ${POLICIES.licensing} Financing: ${POLICIES.financing}
- General timing on site: ${POLICIES.timingGeneral}
- After-hours handling: ${POLICIES.afterHours}
- Current time context: after-hours-now=${afterHoursNow}

Greeting: choose one at random:
1) "Hi, this is Rachel with ${COMPANY_NAME}… how can I help you today?"
2) "${COMPANY_NAME}, this is Rachel speaking. What’s going on with your system?"
3) "Hey there, this is Rachel at ${COMPANY_NAME}… what can I do for you?"

Intake flow:
- First, listen to the issue. Brief empathy and a backchannel (one word).
- Progressively qualify: ask ZIP (or area) to confirm coverage; identify service type from their words.
- If after-hours, offer a gentle choice: "We can send someone tonight if needed, or first thing in the morning. Which works better?" If they don’t specify, proceed normally. If normal hours, proceed without “today/tomorrow” questions.
- Only at the end gather contact details together with a note-taking vibe: name, phone, ZIP if missing, and optionally address if the caller volunteers it. Use brief fillers: "mhmm", "okay", "noted".
- ALWAYS confirm back every captured detail. If the caller says "No, it was XYZ", gracefully correct and repeat the corrected detail.

General questions:
- "How long will it take?" → ${POLICIES.timingGeneral} Tech confirms on site.
- "How soon can a tech be here?" → Same-day in many cases during normal hours; dispatcher/on-call confirms ETA after we log details.
- Pricing → ${POLICIES.pricingStyle}
- Brands → ${POLICIES.brands}
- Warranties → ${POLICIES.warranties}
- Licensing/Insurance → ${POLICIES.licensing}
- Financing → ${POLICIES.financing}
Keep answers one short sentence, then return to intake.

Closing (choose one at random; do not promise instant dispatch):
1) "Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling."
2) "Perfect, I’ll log this now and one of our techs will reach out soon."
3) "Thanks — I’ll pass this along and you’ll get a callback shortly."

IMPORTANT:
- Keep each reply under ~14 words.
- Ask only one question at a time.
- Use small natural confirmations when writing details.
- If you’re unsure, say: "Sorry, could you repeat that for me?"
- Keep tone calm, kind, and efficient.

OUTPUT FORMAT (JSON only, no extra text):
{
  "say": "<your single natural spoken line>",
  "next": "<ask_issue|ask_zip|ask_service|ask_contact|confirm|close|smalltalk|answer_faq>",
  "updates": { "name": "...", "phone": "...", "zip": "...", "service": "...", "address": "..." }
}
- "updates" is partial; include only fields you confidently heard or corrected.
- For corrections, output the corrected field in "updates".
- If you answered a general question, set next to the most logical intake step afterwards.
`;
}

// ---------- OpenAI Structured Turn ----------
async function aiTurn(transcript, userLine) {
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt() },
      ...transcript,
      { role: "user", content: userLine }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  }).then(x => x.json());

  let say = "Sorry, could you repeat that for me?";
  let next = "ask_issue";
  let updates = {};
  try {
    const text = r.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(text);
    say = typeof parsed.say === "string" ? parsed.say : say;
    next = typeof parsed.next === "string" ? parsed.next : next;
    updates = (parsed.updates && typeof parsed.updates === "object") ? parsed.updates : {};
  } catch {
    // fallback defaults above
  }
  return { say, next, updates };
}

// ---------- ElevenLabs TTS ----------
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "Hello.").toString().slice(0, 500);
    const voiceId = process.env.ELEVENLABS_VOICE_ID; // your v3 female ID

    const er = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.35,          // more natural variation
          similarity_boost: 0.95,   // stay on-voice
          style: 0.8,               // more expressive
          use_speaker_boost: true
        }
      })
    });

    if (!er.ok) {
      const errText = await er.text();
      console.error("ElevenLabs API Error:", er.status, errText);
      return res.status(500).send(`TTS error: ${er.status} ${errText}`);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    er.body.pipe(res);
  } catch (e) {
    console.error("TTS exception:", e);
    res.status(500).send("TTS failure");
  }
});

// ---------- Twilio: Entry (/voice) ----------
app.post("/voice", (req, res) => {
  const callerId = req.body.From || nanoid();
  const session = getSession(callerId);

  const twiml = new Twiml.VoiceResponse();

  if (session.step === "greet") {
    // Let the AI pick a greeting variation
    const opener = "Hi, this is Rachel with AC and Heating… how can I help you today?";
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
  g.say({ voice: "alice" }, " ");

  res.type("text/xml").send(twiml.toString());
});

// ---------- Twilio: Turn Handler (/gather) ----------
app.post("/gather", async (req, res) => {
  const callerId = req.body.From || nanoid();
  const session = getSession(callerId);

  const userSaid = (req.body.SpeechResult || "").trim();
  session.turns += 1;
  if (userSaid) session.transcript.push({ role: "user", content: userSaid });

  // Light extraction (regex) to help fill blanks
  const phoneMatch = userSaid.match(/(\+?1?[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (phoneMatch && !session.lead.phone) session.lead.phone = phoneMatch[0];

  const zipMatch = userSaid.match(/\b\d{5}\b/);
  if (zipMatch && !session.lead.zip) session.lead.zip = zipMatch[0];

  // AI decides next line + updates
  const { say, next, updates } = await aiTurn(session.transcript, userSaid);

  // Apply AI updates (supports corrections)
  if (updates) {
    for (const k of ["name", "phone", "zip", "service", "address"]) {
      if (typeof updates[k] === "string" && updates[k].trim()) {
        session.lead[k] = updates[k].trim();
      }
    }
  }

  session.transcript.push({ role: "assistant", content: say });

  // Build spoken line
  const twiml = new Twiml.VoiceResponse();
  const sayUrl = new URL("https://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", say);
  twiml.play(sayUrl.toString());

  // If we appear to be done, confirm everything once, then close
  const ready =
    session.lead.name && session.lead.phone && session.lead.zip && session.lead.service;

  if (next === "confirm" || (ready && session.turns > 2)) {
    const confirmLine =
      `I have ${session.lead.name}, ${session.lead.phone}, ZIP ${session.lead.zip}, ${session.lead.service}. Is that correct?`;
    const cUrl = new URL("https://" + req.get("host") + "/tts");
    cUrl.searchParams.set("text", confirmLine);
    twiml.play(cUrl.toString());

    const g = twiml.gather({
      input: "speech",
      action: "/confirm",
      method: "POST",
      speechTimeout: "auto"
    });
    g.say({ voice: "alice" }, " ");
  } else {
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

// ---------- Confirmation turn ----------
app.post("/confirm", async (req, res) => {
  const callerId = req.body.From || nanoid();
  const session = getSession(callerId);
  const reply = (req.body.SpeechResult || "").toLowerCase();

  const twiml = new Twiml.VoiceResponse();

  // If caller corrects something, we route back to gather
  if (/(no|incorrect|not.*right|that's wrong|wrong)/.test(reply)) {
    const fix = "Thanks for clarifying — what should I correct?";
    const sUrl = new URL("https://" + req.get("host") + "/tts");
    sUrl.searchParams.set("text", fix);
    twiml.play(sUrl.toString());

    const g = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto"
    });
    g.say({ voice: "alice" }, " ");
    return res.type("text/xml").send(twiml.toString());
  }

  // If yes/affirmative or neutral → close and notify
  // (We allow neutral to avoid loops.)
  const closingOptions = [
    "Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling.",
    "Perfect, I’ll log this now and one of our techs will reach out soon.",
    "Thanks — I’ll pass this along and you’ll get a callback shortly."
  ];
  const closing = closingOptions[Math.floor(Math.random() * closingOptions.length)];

  // Send SMS summary if we have enough data
  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_PHONE_NUMBER && process.env.ALERT_PHONE_NUMBER) {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      const L = session.lead;
      const summary = `HVAC Lead | Name: ${L.name || "-"} | Phone: ${L.phone || "-"} | ZIP: ${L.zip || "-"} | Service: ${L.service || "-"} | Address: ${L.address || "-"}`;
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ALERT_PHONE_NUMBER,
        body: summary
      });
      console.log("Lead SMS sent:", summary);
    }
  } catch (e) {
    console.error("SMS error:", e);
  }

  const sUrl = new URL("https://" + req.get("host") + "/tts");
  sUrl.searchParams.set("text", closing);
  twiml.play(sUrl.toString());
  twiml.hangup();

  // cleanup session after close
  SESSIONS.delete(callerId);

  res.type("text/xml").send(twiml.toString());
});

// ---------- Health ----------
app.get("/", (_, res) => res.send("OK"));

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT}`));
