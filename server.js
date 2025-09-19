// server.js (diagnostic-first build)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---- TEMP LOGGING (check SpeechResult). Remove later if you want.
app.use((req, _res, next) => {
  if (req.path === "/voice" || req.path === "/gather" || req.path === "/confirm") {
    try { console.log(`[${req.path}]`, JSON.stringify(req.body || {}, null, 2)); } catch {}
  }
  next();
});

// ============ Config ============
const COMPANY_NAME = process.env.COMPANY_NAME || "AC and Heating";
const COMPANY_CITY = process.env.COMPANY_CITY || "San Antonio";
const BUSINESS_HOURS = { start: 8, end: 18, tz: "America/Chicago" };
const USE_TTS = (process.env.USE_TTS || "off").toLowerCase() === "on"; // <— TOGGLE HERE

const SERVICES = [
  "AC Repair","Heating Repair","New System Installation",
  "Maintenance/Tune-Up","Ductless Mini-Split Service",
  "Thermostat Install/Repair","24/7 Emergency Service"
];
const SERVICE_AREAS = [
  "San Antonio","Alamo Heights","Stone Oak","Helotes","Leon Valley","Shavano Park",
  "Converse","Universal City","Schertz","Cibolo","Selma","Live Oak","New Braunfels","Boerne"
];
const POLICIES = {
  pricingStyle: "Technician diagnoses first, then gives a clear quote before work.",
  warranties: "Manufacturer parts; labor warranty on repairs/installs.",
  brands: "All major brands serviced: Carrier, Trane, Lennox, Rheem, Goodman, etc.",
  licensing: "Licensed and insured.",
  financing: "Financing available on qualifying replacements/installs.",
  timingGeneral: "Most visits run 45–90 minutes; technician confirms on site.",
  afterHours: "After-hours is triaged; on-call confirms ETA after details are logged."
};

// ============ Helpers / State ============
function isAfterHours() {
  try {
    const now = new Date();
    const ct = now.toLocaleString("en-US", { timeZone: BUSINESS_HOURS.tz, hour12: false });
    const hour = parseInt(ct.split(",")[1].trim().split(":")[0], 10);
    return hour < BUSINESS_HOURS.start || hour >= BUSINESS_HOURS.end;
  } catch {
    const h = new Date().getHours();
    return h < 8 || h >= 18;
  }
}
function looksSpanish(t=""){ t=t.toLowerCase(); return /¿|¡|usted|ustedes|necesito|aire|calefacci[oó]n|reparaci[oó]n|instalaci[oó]n|mañana|hoy|urgente|no enfr[ií]a|no calienta/.test(t); }

const SESSIONS = new Map();
function getSession(id){
  let s = SESSIONS.get(id);
  if(!s){
    s = { id, lang:"en", lead:{name:"",phone:"",zip:"",service:"",address:""}, transcript:[], lastSay:"", turns:0, step:"greet", noSpeechCount:0 };
    SESSIONS.set(id,s);
  }
  return s;
}

const CALL_METRICS = new Map(); // simple spam control
function recordCallStart(from){
  const m = CALL_METRICS.get(from) || { timestamps:[], shortHangs:0, flagged:false, deny:false };
  m.timestamps.push(Date.now());
  m.timestamps = m.timestamps.filter(t=>Date.now()-t<24*3600*1000);
  CALL_METRICS.set(from,m);
}
function isRateLimited(from){
  const m = CALL_METRICS.get(from); if(!m) return false;
  const recent = m.timestamps.filter(t=>Date.now()-t<10*60*1000);
  return recent.length>=3 || m.flagged || m.deny;
}

// ============ System Prompt ============
function systemPrompt(session){
  const afterHoursNow = isAfterHours() ? "yes" : "no";
  const baseEN = `
You are “Rachel,” a warm, human receptionist for ${COMPANY_NAME} in ${COMPANY_CITY}.
Speak like a person: short sentences (5–12 words), natural rhythm, light warmth.
CONTEXT: after-hours-now=${afterHoursNow}. Speak English unless caller speaks Spanish, then switch.

STYLE
- One sentence per turn, under ~14 words.
- Contractions and natural punctuation: commas, em-dashes — and ellipses…
- Light backchannels while “jotting”: mhmm, okay, got it, alright, one sec (sparingly).
- Never talk over the caller. Wait for them to finish.
- Never say you are AI. Never promise exact ETAs or prices.
- Don’t repeat the same sentence; rephrase instead.

FACTS
- Services: ${SERVICES.join(", ")}.
- Areas: ${SERVICE_AREAS.join(", ")}.
- Policies: ${POLICIES.pricingStyle} ${POLICIES.warranties}
  Brands: ${POLICIES.brands} Licensing: ${POLICIES.licensing} Financing: ${POLICIES.financing}
  Typical visit: ${POLICIES.timingGeneral} After-hours: ${POLICIES.afterHours}

GREETING (pick 1)
1) “Hi, this is Rachel with ${COMPANY_NAME}… how can I help you today?”
2) “${COMPANY_NAME}, this is Rachel speaking. What’s going on with your system?”
3) “Hey there, this is Rachel at ${COMPANY_NAME}… what can I do for you?”

FLOW
1) Let them describe the issue. Brief empathy + one backchannel.
2) Ask ZIP (or area). Infer service type; one clarifying question if needed.
3) After-hours-now=yes → offer once: “We can send someone tonight if needed, or first thing in the morning. Which works better?” If not specified, proceed normally. During normal hours, proceed normally.
4) End intake: name, phone, ZIP if missing, address only if offered. Use short backchannels.
5) Confirm line: “I have NAME, PHONE, ZIP, SERVICE. Is that correct?”
   If they correct: “Thanks for clarifying — I’ll update that to XYZ.” Then restate corrected once.

FAQ (brief, then back to intake)
- “How long?” → “Usually 45–90 minutes. The tech confirms on site.”
- “How soon?” → “Often same-day in normal hours; dispatcher confirms ETA after we log details.”
- “Cost?” → “Tech diagnoses first, then gives a clear quote before work.”
- “Brand?” → “Yes, we handle all major brands.”
- “Warranties?” → “Manufacturer parts and labor on repairs/installs.”
- “Licensed/insured?” → “Yes.”
- “Financing?” → “Yes, on qualifying replacements/installs.”

CLOSING (pick 1; no instant-dispatch promises)
1) “Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling.”
2) “Perfect, I’ll log this now and one of our techs will reach out soon.”
3) “Thanks — I’ll pass this along and you’ll get a callback shortly.”

CLARIFY IF UNCLEAR (vary phrasing)
- “Sorry, could you repeat that for me?”
- “I didn’t catch that — could you say it again?”
- “One more time, please?”

OUTPUT — STRICT JSON ONLY:
{"say":"<natural line>","next":"<ask_issue|ask_zip|ask_service|ask_contact|confirm|close|answer_faq>","updates":{"name":"...","phone":"...","zip":"...","service":"...","address":"..."}}
`.trim();

  const baseES = `
Eres “Rachel”, recepcionista cálida para ${COMPANY_NAME} en ${COMPANY_CITY}.
Frases cortas (5–12 palabras), ritmo natural y cercanía.
CONTEXTO: after-hours-now=${afterHoursNow}. Cambia a español si el cliente lo usa.

ESTILO
- Una frase por turno (<14 palabras), con pausas naturales.
- Retroalimentación breve al anotar: “mm”, “ok”, “de acuerdo”, “bien” (con moderación).
- No interrumpas. No prometas ETAs ni precios exactos. No repitas la misma frase.

DATOS
- Servicios: ${SERVICES.join(", ")}.
- Zonas: ${SERVICE_AREAS.join(", ")}.
- Políticas: ${POLICIES.pricingStyle} ${POLICIES.warranties}
  Marcas: ${POLICIES.brands} Licencia: ${POLICIES.licensing} Financiamiento: ${POLICIES.financing}
  Visita: ${POLICIES.timingGeneral} Fuera de horario: ${POLICIES.afterHours}

SALUDO (elige 1)
1) “Hola, habla Rachel de ${COMPANY_NAME}… ¿en qué puedo ayudarle hoy?”
2) “${COMPANY_NAME}, le atiende Rachel. ¿Qué sucede con su sistema?”
3) “Buenas, soy Rachel en ${COMPANY_NAME}… ¿cómo puedo ayudarle?”

FLUJO, PREGUNTAS, CIERRE y ACLARACIONES — igual que en inglés.

SALIDA — SOLO JSON:
{"say":"<línea natural>","next":"<ask_issue|ask_zip|ask_service|ask_contact|confirm|close|answer_faq>","updates":{"name":"...","phone":"...","zip":"...","service":"...","address":"..."}}
`.trim();

  return session.lang === "es" ? baseES : baseEN;
}

// ============ OpenAI (structured) ============
async function aiTurn(session, userLine){
  const fallbackResponse = () => {
    const isSpanish = session.lang === "es";
    const steps = [
      {
        key: "zip",
        next: "ask_zip",
        say: isSpanish ? "¿Me comparte su código postal?" : "Could you share the ZIP you're in?"
      },
      {
        key: "service",
        next: "ask_service",
        say: isSpanish ? "¿Qué tipo de servicio necesita?" : "What kind of service do you need?"
      },
      {
        key: "name",
        next: "ask_contact",
        say: isSpanish ? "¿A nombre de quién registro la visita?" : "What name should I put on the ticket?"
      },
      {
        key: "phone",
        next: "ask_contact",
        say: isSpanish ? "¿Cuál es el mejor número para contactarle?" : "What's the best number to reach you?"
      }
    ];

    for (const step of steps) {
      if (!session.lead[step.key]) {
        return { say: step.say, next: step.next, updates: {} };
      }
    }

    return {
      say: isSpanish
        ? "Perfecto, tengo todos los datos. ¿Está bien así?"
        : "Great, I have everything I need. Does that look right?",
      next: "confirm",
      updates: {}
    };
  };

  const responseSchema = {
    name: "ai_turn_response",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["say", "next", "updates"],
      properties: {
        say: { type: "string" },
        next: {
          type: "string",
          enum: ["ask_issue", "ask_zip", "ask_service", "ask_contact", "confirm", "close", "answer_faq"]
        },
        updates: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            zip: { type: "string" },
            service: { type: "string" },
            address: { type: "string" }
          }
        }
      }
    }
  };

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    response_format: { type: "json_schema", json_schema: responseSchema },
    messages: [
      { role: "system", content: systemPrompt(session) },
      ...session.transcript,
      { role: "user", content: userLine }
    ]
  };

  const fallback = fallbackResponse();

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(payload)
    }).then(x => x.json());

    if (r.error) throw new Error(r.error.message || "OpenAI error");

    const choice = r.choices?.[0];
    let raw = choice?.message?.content;
    if (Array.isArray(raw)) raw = raw.map(part => part?.text || "").join("");
    if (typeof raw !== "string") throw new Error("No content in completion");

    const parsed = JSON.parse(raw);
    const say = typeof parsed.say === "string" ? parsed.say.trim() : "";
    const next = typeof parsed.next === "string" ? parsed.next.trim() : "";
    const updates = parsed.updates && typeof parsed.updates === "object" ? parsed.updates : {};

    return {
      say: say || fallback.say,
      next: next || fallback.next,
      updates: { ...fallback.updates, ...updates }
    };
  } catch (err) {
    console.error("aiTurn fallback", err);
    return fallback;
  }
}

// ============ ElevenLabs TTS ============
async function ttsUrlFor(text, req){
  const sayUrl = new URL("https://" + req.get("host") + "/tts");
  sayUrl.searchParams.set("text", text);
  return sayUrl.toString();
}
app.get("/tts", async (req, res) => {
  if (!USE_TTS) return res.status(200).end(); // in diagnostic mode we won't call this
  try {
    const textRaw = (req.query.text || "Hello.").toString();
    const text = textRaw.length < 20 ? textRaw + "…" : textRaw;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
    url.searchParams.set("optimize_streaming_latency", "3");

    const er = await fetch(url.toString(), {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.24, similarity_boost: 0.99, style: 0.95, use_speaker_boost: true }
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

// ============ Twilio /voice ============
app.post("/voice", async (req, res) => {
  const from = req.body.From || nanoid();
  recordCallStart(from);

  if (isRateLimited(from)) {
    const tw = new Twiml.VoiceResponse();
    tw.say("We’re unavailable at the moment. Please leave a message after the tone.");
    tw.record({ action: "/vm-finish", maxLength: 90, playBeep: true });
    return res.type("text/xml").send(tw.toString());
  }

  const session = getSession(from);
  const twiml = new Twiml.VoiceResponse();
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    language: session.lang === "es" ? "es-US" : "en-US",
    speechModel: "phone_call",
    profanityFilter: "false"
  });

  if (session.step === "greet") {
    const opener = `Hi, this is Rachel with ${COMPANY_NAME}… how can I help you today?`;
    if (USE_TTS) {
      g.play({ bargeIn: true }, await ttsUrlFor(opener, req));
    } else {
      g.say({ bargeIn: true, voice: "alice" }, opener);
    }
    session.transcript.push({ role: "assistant", content: opener });
    session.step = "intake";
  } else {
    g.say({ bargeIn: true, voice: "alice" }, " ");
  }

  res.type("text/xml").send(twiml.toString());
});

// ============ Twilio /gather ============
app.post("/gather", async (req, res) => {
  const from = req.body.From || nanoid();
  const session = getSession(from);

  const userSaid = (req.body.SpeechResult || "").trim();
  session.turns += 1;

  if (userSaid && looksSpanish(userSaid)) session.lang = "es";

  if (!userSaid) {
    session.noSpeechCount = (session.noSpeechCount || 0) + 1;

    if (session.noSpeechCount >= 3) {
      const vr = new Twiml.VoiceResponse();
      const line = session.lang === "es"
        ? "De acuerdo, grabaremos un mensaje para el despachador."
        : "No problem. I’ll record a quick message for dispatch.";
      if (USE_TTS) vr.play(await ttsUrlFor(line, req)); else vr.say(line);
      vr.redirect("/voicemail");
      return res.type("text/xml").send(vr.toString());
    }

    const retry = session.lang === "es"
      ? [
          "No alcancé a escuchar esa parte—¿podría decirla otra vez?",
          "Perdón, no estuvo claro. Una vez más, por favor.",
          "Espere tantito—¿podría decir eso una vez más?"
        ]
      : [
          "I didn’t catch that part—could you say it again?",
          "Sorry, that wasn’t clear. One more time, please.",
          "Hang on—could you say that once more?"
        ];
    const line = retry[session.noSpeechCount % retry.length];

    const tw = new Twiml.VoiceResponse();
    const g = tw.gather({
      input: "speech", action: "/gather", method: "POST",
      speechTimeout: "auto",
      language: session.lang === "es" ? "es-US" : "en-US",
      speechModel: "phone_call", profanityFilter: "false"
    });
    if (USE_TTS) g.play({ bargeIn: true }, await ttsUrlFor(line, req));
    else g.say({ bargeIn: true, voice: "alice" }, line);
    return res.type("text/xml").send(tw.toString());
  }

  // reset no-speech counter
  session.noSpeechCount = 0;

  // light extraction
  const phoneMatch = userSaid.match(/(\+?1?[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (phoneMatch && !session.lead.phone) session.lead.phone = phoneMatch[0];
  const zipMatch = userSaid.match(/\b\d{5}\b/);
  if (zipMatch && !session.lead.zip) session.lead.zip = zipMatch[0];

  session.transcript.push({ role: "user", content: userSaid });

  const { say: aiSay, next, updates } = await aiTurn(session, userSaid);
  if (updates) for (const k of ["name","phone","zip","service","address"]) {
    if (typeof updates[k] === "string" && updates[k].trim()) session.lead[k] = updates[k].trim();
  }

  let say = aiSay;
  if (say === session.lastSay) say = (session.lang==="es"?"Entendido. ":"Got it. ") + say;
  session.lastSay = say;
  session.transcript.push({ role: "assistant", content: say });

  const twiml = new Twiml.VoiceResponse();
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    language: session.lang === "es" ? "es-US" : "en-US",
    speechModel: "phone_call",
    profanityFilter: "false"
  });
  if (USE_TTS) g.play({ bargeIn: true }, await ttsUrlFor(say, req));
  else g.say({ bargeIn: true, voice: "alice" }, say);

  const ready = session.lead.name && session.lead.phone && session.lead.zip && session.lead.service;
  if (next === "confirm" || (ready && session.turns > 2)) {
    const confirm = session.lang === "es"
      ? `Tengo ${session.lead.name}, ${session.lead.phone}, código ${session.lead.zip}, ${session.lead.service}. ¿Correcto?`
      : `I have ${session.lead.name}, ${session.lead.phone}, ZIP ${session.lead.zip}, ${session.lead.service}. Is that correct?`;

    const tw2 = new Twiml.VoiceResponse();
    const gg = tw2.gather({
      input: "speech",
      action: "/confirm",
      method: "POST",
      speechTimeout: "auto",
      language: session.lang === "es" ? "es-US" : "en-US",
      speechModel: "phone_call",
      profanityFilter: "false"
    });
    if (USE_TTS) gg.play({ bargeIn: true }, await ttsUrlFor(confirm, req));
    else gg.say({ bargeIn: true, voice: "alice" }, confirm);
    return res.type("text/xml").send(tw2.toString());
  }

  res.type("text/xml").send(twiml.toString());
});

// ============ Twilio /confirm ============
app.post("/confirm", async (req, res) => {
  const from = req.body.From || nanoid();
  const session = getSession(from);
  const reply = (req.body.SpeechResult || "").toLowerCase();

  const twiml = new Twiml.VoiceResponse();

  if (/(no|incorrect|not.*right|wrong)/.test(reply)) {
    const fix = session.lang === "es" ? "Gracias por aclararlo — ¿qué debo corregir?" : "Thanks for clarifying — what should I correct?";
    const g = twiml.gather({
      input: "speech", action: "/gather", method: "POST",
      speechTimeout: "auto",
      language: session.lang === "es" ? "es-US" : "en-US",
      speechModel: "phone_call", profanityFilter: "false"
    });
    if (USE_TTS) {
      const url = new URL("https://" + req.get("host") + "/tts"); url.searchParams.set("text", fix);
      g.play({ bargeIn: true }, url.toString());
    } else g.say({ bargeIn: true, voice: "alice" }, fix);
    return res.type("text/xml").send(twiml.toString());
  }

  const closers = session.lang === "es"
    ? ["Perfecto, ya tengo sus datos. El despachador le llamará para confirmar.",
       "Muy bien, lo registro y un técnico se pondrá en contacto pronto.",
       "Gracias; en breve recibirá una llamada para coordinar la visita."]
    : ["Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling.",
       "Perfect, I’ll log this now and one of our techs will reach out soon.",
       "Thanks — I’ll pass this along and you’ll get a callback shortly."];
  const closing = closers[Math.floor(Math.random()*closers.length)];

  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_PHONE_NUMBER && process.env.ALERT_PHONE_NUMBER) {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      const L = session.lead;
      const summary = `HVAC Lead | Name: ${L.name||"-"} | Phone: ${L.phone||"-"} | ZIP: ${L.zip||"-"} | Service: ${L.service||"-"} | Address: ${L.address||"-"}`;
      await client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ALERT_PHONE_NUMBER, body: summary });
      console.log("Lead SMS sent:", summary);
    }
  } catch(e){ console.error("SMS error:", e); }

  const tw = new Twiml.VoiceResponse();
  if (USE_TTS) {
    const url = new URL("https://" + req.get("host") + "/tts"); url.searchParams.set("text", closing);
    tw.play(url.toString());
  } else tw.say(closing);
  tw.hangup();

  SESSIONS.delete(from);
  res.type("text/xml").send(tw.toString());
});

// ============ Voicemail ============
app.post("/voicemail", (req, res) => {
  const vr = new Twiml.VoiceResponse();
  const line = "After the tone, please share your name, number, ZIP, and the issue.";
  if (USE_TTS) {
    const url = new URL("https://" + req.get("host") + "/tts"); url.searchParams.set("text", line);
    vr.play(url.toString());
  } else vr.say(line);
  vr.record({ action: "/vm-finish", maxLength: 90, playBeep: true });
  vr.say("Got it. Thanks. Goodbye.");
  res.type("text/xml").send(vr.toString());
});
app.post("/vm-finish", async (req, res) => {
  const from = req.body.From || "unknown";
  const recordingUrl = req.body.RecordingUrl;
  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_PHONE_NUMBER && process.env.ALERT_PHONE_NUMBER) {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      await client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ALERT_PHONE_NUMBER, body: `VM from ${from}: ${recordingUrl}` });
    }
  } catch(e){ console.error("VM SMS error:", e); }
  const tw = new Twiml.VoiceResponse();
  tw.say("Thanks. We’ll call you shortly. Goodbye.");
  tw.hangup();
  res.type("text/xml").send(tw.toString());
});

// ============ Health ============
app.get("/", (_req, res) => res.send("OK"));

// ============ Boot ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT} | USE_TTS=${USE_TTS ? "on" : "off"}`));
