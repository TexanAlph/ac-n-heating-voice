// server.js — Deterministic FSM receptionist (stable, honest)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const COMPANY_NAME = process.env.COMPANY_NAME || "AC and Heating";
const COMPANY_CITY = process.env.COMPANY_CITY || "San Antonio";
const USE_TTS = (process.env.USE_TTS || "off").toLowerCase() === "on";  // off = use Twilio <Say>
const BUSINESS_TZ = "America/Chicago";

const SERVICES = [
  "AC Repair","Heating Repair","New System Installation",
  "Maintenance","Ductless Mini-Split","Thermostat Service","24/7 Emergency"
];

const SMS_SUMMARY_TO = process.env.ALERT_PHONE_NUMBER;        // your cell
const TWILIO_FROM     = process.env.TWILIO_PHONE_NUMBER;      // your Twilio #
const TWILIO_SID      = process.env.TWILIO_SID;
const TWILIO_AUTH     = process.env.TWILIO_AUTH;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY      = process.env.OPENAI_API_KEY;

// ---------- State (in-memory) ----------
const SESS = new Map(); // by caller id
function getSess(id){
  let s = SESS.get(id);
  if (!s) {
    s = {
      id, lang: "en",
      step: "greet",
      noSpeech: 0,
      lead: { issue:"", zip:"", name:"", phone:"" },
      asked: { issue:false, zip:false, name:false, phone:false },
      notes: []
    };
    SESS.set(id, s);
  }
  return s;
}

// ---------- Utils ----------
function isSpanishGuess(t=""){
  t = (t||"").toLowerCase();
  return /¿|¡|usted|ustedes|necesito|aire|calefacci[oó]n|reparaci[oó]n|instalaci[oó]n|no enfr[ií]a|no calienta|t[eé]cnico|c[oó]digo postal/.test(t);
}
async function ttsUrl(text, req){
  const u = new URL("https://" + req.get("host") + "/tts");
  u.searchParams.set("text", text);
  return u.toString();
}
function gatherOpts(lang){
  return {
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    language: lang === "es" ? "es-US" : "en-US",
    speechModel: "phone_call",
    profanityFilter: "false"
  };
}

// ---------- Minimal extraction (OpenAI used only for JSON) ----------
async function extractEntities(userText){
  // Regex first (cheap & reliable)
  const out = {};
  const phone = userText.match(/(\+?1?[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  const zip   = userText.match(/\b\d{5}\b/);
  if (phone) out.phone = phone[0];
  if (zip)   out.zip   = zip[0];

  // If no OpenAI key, just return regex + simple service guess
  if (!OPENAI_KEY) {
    if (/thermostat/i.test(userText)) out.service = "Thermostat Service";
    else if (/install|replace|new unit|new system/i.test(userText)) out.service = "New System Installation";
    else if (/heater|furnace|heat/i.test(userText)) out.service = "Heating Repair";
    else if (/ac|air.?condition|not cold|warm air/i.test(userText)) out.service = "AC Repair";
    else if (/maint|tune.?up/i.test(userText)) out.service = "Maintenance";
    return out;
  }

  // LLM extraction: JSON only, no prose
  const schema = {
    type: "object",
    properties: {
      language: { type: "string", enum: ["en","es"] },
      service: { type: "string", enum: ["AC Repair","Heating Repair","New System Installation","Maintenance","Ductless Mini-Split","Thermostat Service","24/7 Emergency","unknown"] },
      zip: { type: "string" },
      phone: { type: "string" },
      name: { type: "string" },
      note: { type: "string" }
    },
    required: ["language","service"]
  };

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract fields from caller text. Output ONLY JSON matching the schema. " +
          "If language appears Spanish, set language='es'; else 'en'. " +
          "Infer service intent from text using provided options; use 'unknown' if unsure."
      },
      { role: "user", content: userText },
      { role: "user", content: "JSON schema (informative, follow it): " + JSON.stringify(schema) }
    ]
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(payload)
    }).then(x => x.json());
    const raw = r.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return { ...out, ...parsed };
  } catch {
    return out;
  }
}

// ---------- ElevenLabs TTS endpoint (optional) ----------
app.get("/tts", async (req, res) => {
  if (!USE_TTS) return res.status(200).end();
  try {
    const text = (req.query.text || "Hello.").toString();
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`);
    url.searchParams.set("optimize_streaming_latency", "3");

    const er = await fetch(url.toString(), {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.length < 20 ? text + "…" : text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.25, similarity_boost: 0.99, style: 0.95, use_speaker_boost: true }
      })
    });
    if (!er.ok) {
      const t = await er.text();
      console.error("ElevenLabs error:", er.status, t);
      return res.status(500).send("TTS error");
    }
    res.setHeader("Content-Type", "audio/mpeg");
    er.body.pipe(res);
  } catch(e) {
    console.error("TTS exception:", e);
    res.status(500).send("TTS failure");
  }
});

// ---------- Script lines (deterministic) ----------
const L = {
  greet_en: `Hi, this is Rachel with ${COMPANY_NAME}. How can I help you today?`,
  greet_es: `Hola, habla Rachel de ${COMPANY_NAME}. ¿En qué puedo ayudarle hoy?`,

  ask_issue_en: "What seems to be going on with the system?",
  ask_issue_es: "¿Qué sucede con su sistema?",

  empathize_en: "I’m sorry that’s happening — I’ll note that for the technician.",
  empathize_es: "Lamento lo que ocurre — lo anoto para el técnico.",

  ask_zip_en: "What’s your ZIP code so I can confirm coverage?",
  ask_zip_es: "¿Cuál es su código postal para confirmar cobertura?",

  ask_name_en: "What’s your name?",
  ask_name_es: "¿Cómo se llama?",

  ask_phone_en: "What’s the best phone number to reach you?",
  ask_phone_es: "¿Cuál es el mejor número para localizarle?",

  honest_en: "If anything needs a specific answer, I’ll have the tech confirm for you.",
  honest_es: "Si algo requiere una respuesta específica, el técnico se lo confirmará.",

  confirm_en: (s) => `I have ${s.name || "—"}, ${s.phone || "—"}, ZIP ${s.zip || "—"}. Is that correct?`,
  confirm_es: (s) => `Tengo ${s.name || "—"}, ${s.phone || "—"}, código ${s.zip || "—"}. ¿Es correcto?`,

  closing_en: [
    "Great — I’ll pass this to dispatch and they’ll follow up shortly.",
    "Perfect — I’ll log this now and our team will call to confirm.",
    "Thanks — you’ll get a quick callback to coordinate the visit."
  ],
  closing_es: [
    "Perfecto — lo paso a despacho y le llamarán en breve.",
    "Muy bien — lo registro y el equipo le llamará para confirmar.",
    "Gracias — recibirá una llamada en breve para coordinar la visita."
  ],

  retry_en: [
    "I didn’t catch that part — could you say it again?",
    "Sorry, that wasn’t clear. One more time, please.",
    "Hang on — could you say that once more?"
  ],
  retry_es: [
    "No escuché esa parte. ¿Podría decirlo de nuevo?",
    "Lo siento, no quedó claro. ¿Otra vez, por favor?",
    "Un momento… ¿podría decirlo una vez más?"
  ]
};

// ---------- Say/Play inside Gather ----------
async function sayInGather(tw, req, lang, text){
  const g = tw.gather(gatherOpts(lang));
  if (USE_TTS) g.play({ bargeIn: true }, await ttsUrl(text, req));
  else g.say({ bargeIn: true, voice: "alice" }, text);
  return tw;
}

// ---------- Voice entry ----------
app.post("/voice", async (req, res) => {
  const from = req.body.From || nanoid();
  const s = getSess(from);

  const tw = new Twiml.VoiceResponse();
  const text = s.lang === "es" ? L.greet_es : L.greet_en;
  s.step = "issue";
  await sayInGather(tw, req, s.lang, text);
  res.type("text/xml").send(tw.toString());
});

// ---------- Gather handler (FSM) ----------
app.post("/gather", async (req, res) => {
  const from = req.body.From || nanoid();
  const s = getSess(from);
  const said = (req.body.SpeechResult || "").trim();

  // language switch
  if (said && isSpanishGuess(said)) s.lang = "es";

  // no speech handling
  if (!said) {
    s.noSpeech++;
    if (s.noSpeech >= 3) {
      const vr = new Twiml.VoiceResponse();
      const line = s.lang === "es"
        ? "De acuerdo, deje un mensaje con nombre, número y código postal."
        : "No problem. Please leave your name, number, and ZIP after the tone.";
      if (USE_TTS) vr.play(await ttsUrl(line, req)); else vr.say(line);
      vr.record({ action: "/vm-finish", maxLength: 90, playBeep: true });
      return res.type("text/xml").send(vr.toString());
    }
    const tw = new Twiml.VoiceResponse();
    const retry = s.lang === "es" ? L.retry_es : L.retry_en;
    await sayInGather(tw, req, s.lang, retry[s.noSpeech % retry.length]);
    return res.type("text/xml").send(tw.toString());
  }
  s.noSpeech = 0;

  // small extraction/classification
  try {
    const ext = await extractEntities(said);
    if (ext.language) s.lang = ext.language;
    if (ext.zip && !s.lead.zip) s.lead.zip = ext.zip;
    if (ext.phone && !s.lead.phone) s.lead.phone = ext.phone;
    if (ext.name && !s.lead.name) s.lead.name = ext.name;
    if (ext.service && ext.service !== "unknown" && !s.lead.issue) s.lead.issue = ext.service;
    if (ext.note) s.notes.push(ext.note);
  } catch {}

  // very basic name heuristic if they say "my name is X"
  const nameMatch = said.match(/my name is ([a-zA-Z\s\-']+)/i) || said.match(/soy ([a-zA-Z\s\-']+)/i);
  if (nameMatch && !s.lead.name) s.lead.name = nameMatch[1].trim();

  // FSM
  const tw = new Twiml.VoiceResponse();
  const lang = s.lang;

  if (s.step === "issue") {
    s.asked.issue = true;
    // store freeform issue if not set by classifier
    if (!s.lead.issue) s.lead.issue = "Service request";
    const line = (lang === "es" ? L.empathize_es : L.empathize_en) + " " + (lang==="es"?L.ask_zip_es:L.ask_zip_en);
    s.step = "zip";
    await sayInGather(tw, req, lang, line);
    return res.type("text/xml").send(tw.toString());
  }

  if (s.step === "zip") {
    if (!s.lead.zip) {
      const ask = lang==="es" ? L.ask_zip_es : L.ask_zip_en;
      await sayInGather(tw, req, lang, ask);
      return res.type("text/xml").send(tw.toString());
    }
    s.step = "name";
    await sayInGather(tw, req, lang, lang==="es"?L.ask_name_es:L.ask_name_en);
    return res.type("text/xml").send(tw.toString());
  }

  if (s.step === "name") {
    if (!s.lead.name) {
      await sayInGather(tw, req, lang, lang==="es"?L.ask_name_es:L.ask_name_en);
      return res.type("text/xml").send(tw.toString());
    }
    s.step = "phone";
    await sayInGather(tw, req, lang, lang==="es"?L.ask_phone_es:L.ask_phone_en);
    return res.type("text/xml").send(tw.toString());
  }

  if (s.step === "phone") {
    if (!s.lead.phone) {
      await sayInGather(tw, req, lang, lang==="es"?L.ask_phone_es:L.ask_phone_en);
      return res.type("text/xml").send(tw.toString());
    }
    s.step = "confirm";
  }

  if (s.step === "confirm") {
    const confirm = (lang==="es"?L.confirm_es(s.lead):L.confirm_en(s.lead));
    // gather yes/no once
    const g = tw.gather(gatherOpts(lang));
    if (USE_TTS) g.play({ bargeIn:true }, await ttsUrl(confirm, req));
    else g.say({ bargeIn:true, voice:"alice" }, confirm);
    s.step = "close";
    return res.type("text/xml").send(tw.toString());
  }

  if (s.step === "close") {
    // detect obvious "no" to fix and loop back once
    const saidLow = said.toLowerCase();
    if (/(no|wrong|incorrect)/.test(saidLow)) {
      s.step = "name"; // restart details quickly
      await sayInGather(tw, req, lang, lang==="es"?"Gracias. Empecemos por su nombre.":"Thanks. Let’s start with your name.");
      return res.type("text/xml").send(tw.toString());
    }
    // Honest statement + close
    const lines = lang==="es" ? L.closing_es : L.closing_en;
    const honest = lang==="es" ? L.honest_es : L.honest_en;
    const closing = `${honest} ${lines[Math.floor(Math.random()*lines.length)]}`;

    // SMS the lead
    try {
      if (TWILIO_SID && TWILIO_AUTH && TWILIO_FROM && SMS_SUMMARY_TO) {
        const client = new Twilio(TWILIO_SID, TWILIO_AUTH);
        const Ld = s.lead;
        const body = `HVAC Lead | Name: ${Ld.name} | Phone: ${Ld.phone} | ZIP: ${Ld.zip} | Issue: ${Ld.issue}`;
        await client.messages.create({ from: TWILIO_FROM, to: SMS_SUMMARY_TO, body });
      }
    } catch(e){ console.error("SMS error", e); }

    if (USE_TTS) tw.play(await ttsUrl(closing, req)); else tw.say(closing);
    tw.hangup();
    SESS.delete(from);
    return res.type("text/xml").send(tw.toString());
  }

  // default safety
  await sayInGather(tw, req, lang, lang==="es"?L.ask_issue_es:L.ask_issue_en);
  s.step = "issue";
  return res.type("text/xml").send(tw.toString());
});

// ---------- Voicemail ----------
app.post("/vm-finish", async (req, res) => {
  const from = req.body.From || "unknown";
  const recordingUrl = req.body.RecordingUrl;
  try {
    if (TWILIO_SID && TWILIO_AUTH && TWILIO_FROM && SMS_SUMMARY_TO) {
      const client = new Twilio(TWILIO_SID, TWILIO_AUTH);
      await client.messages.create({ from: TWILIO_FROM, to: SMS_SUMMARY_TO, body: `VM from ${from}: ${recordingUrl}` });
    }
  } catch(e){ console.error("VM SMS error", e); }
  const tw = new Twiml.VoiceResponse();
  tw.say("Thanks. We’ll call you shortly. Goodbye.");
  tw.hangup();
  res.type("text/xml").send(tw.toString());
});

// ---------- Health ----------
app.get("/", (_req, res) => res.send("OK"));

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Deterministic HVAC receptionist on ${PORT} | USE_TTS=${USE_TTS ? "on":"off"}`));
