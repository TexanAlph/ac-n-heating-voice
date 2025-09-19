// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { nanoid } from "nanoid";

// Twilio CJS import
import twilioPkg from "twilio";
const { twiml: Twiml, Twilio } = twilioPkg;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== TEMP LOGGING (see SpeechResult in Render logs; remove later if you want) =====
app.use((req, _res, next) => {
  if (req.path === "/voice" || req.path === "/gather" || req.path === "/confirm") {
    try { console.log(`[${req.path}]`, JSON.stringify(req.body || {}, null, 2)); } catch {}
  }
  next();
});

/* ========= Config & Embedded Site Knowledge ========= */
const COMPANY_NAME = process.env.COMPANY_NAME || "AC and Heating";
const COMPANY_CITY = process.env.COMPANY_CITY || "San Antonio";
const BUSINESS_HOURS = { start: 8, end: 18, tz: "America/Chicago" }; // 8am–6pm CT

const SERVICES = [
  "AC Repair",
  "Heating Repair",
  "New System Installation",
  "Maintenance/Tune-Up",
  "Ductless Mini-Split Service",
  "Thermostat Install/Repair",
  "24/7 Emergency Service"
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

/* ================= Helpers / State ================== */
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
function looksSpanish(t = "") {
  t = t.toLowerCase();
  return /¿|¡|usted|ustedes|necesito|aire|calefacci[oó]n|reparaci[oó]n|instalaci[oó]n|mañana|hoy|urgente|no enfr[ií]a|no calienta/.test(t);
}

// Sessions keyed by From (repeat caller resumes)
const SESSIONS = new Map();
function getSession(callerId) {
  let s = SESSIONS.get(callerId);
  if (!s) {
    s = {
      id: callerId,
      lang: "en",
      lead: { name: "", phone: "", zip: "", service: "", address: "" },
      transcript: [],
      lastSay: "",
      turns: 0,
      step: "greet",
      noSpeechCount: 0
    };
    SESSIONS.set(callerId, s);
  }
  return s;
}

// Simple spam/blacklist metrics (in-memory)
const CALL_METRICS = new Map(); // from -> { timestamps:[], shortHangs: n, flagged: bool, deny: bool }
function recordCallStart(from) {
  const m = CALL_METRICS.get(from) || { timestamps: [], shortHangs: 0, flagged: false, deny: false };
  m.timestamps.push(Date.now());
  m.timestamps = m.timestamps.filter(t => Date.now() - t < 24 * 3600 * 1000);
  CALL_METRICS.set(from, m);
}
function markShortHang(from) {
  const m = CALL_METRICS.get(from); if (!m) return;
  m.shortHangs = (m.shortHangs || 0) + 1;
  if (m.shortHangs >= 3) m.flagged = true; // VM-only mode
}
function isRateLimited(from) {
  const m = CALL_METRICS.get(from); if (!m) return false;
  const recent = m.timestamps.filter(t => Date.now() - t < 10 * 60 * 1000);
  return recent.length >= 3 || m.flagged || m.deny;
}

/* ================== System Prompt =================== */
function systemPrompt(session) {
  const afterHoursNow = isAfterHours() ? "yes" : "no";

  const baseEN = `
You are “Rachel,” a warm, human receptionist for ${COMPANY_NAME} in ${COMPANY_CITY}.
You sound like a real person: short sentences (5–12 words), natural rhythm, light warmth.
CONTEXT: after-hours-now=${afterHoursNow}. Speak English unless caller speaks Spanish, then switch.

STYLE (critical)
- One sentence at a time. Keep it under ~14 words.
- Use contractions (I’ll, we’ll, that’s). Avoid stiff wording.
- Use punctuation to shape prosody: commas, em-dashes — and ellipses…
- Sprinkle light backchannels only while “jotting” details: mhmm, okay, got it, alright, one sec. Use sparingly.
- Never talk over the caller. Wait for them to finish.
- Never say you are AI.
- Never promise exact ETAs or prices.
- Never repeat the exact same sentence; rephrase instead.

COMPANY FACTS
- Services: ${SERVICES.join(", ")}.
- Areas: ${SERVICE_AREAS.join(", ")}.
- Policies: ${POLICIES.pricingStyle} ${POLICIES.warranties}
  Brands: ${POLICIES.brands} Licensing: ${POLICIES.licensing} Financing: ${POLICIES.financing}
  Typical visit: ${POLICIES.timingGeneral}
  After-hours: ${POLICIES.afterHours}

GREETING (pick one randomly)
1) “Hi, this is Rachel with ${COMPANY_NAME}… how can I help you today?”
2) “${COMPANY_NAME}, this is Rachel speaking. What’s going on with your system?”
3) “Hey there, this is Rachel at ${COMPANY_NAME}… what can I do for you?”

FLOW
1) Let them describe the problem. Offer brief empathy + one light backchannel.
2) Progressively qualify:
   - Ask ZIP (or area) to confirm coverage.
   - Infer service type from their words; clarify with one short question if needed.
3) After-hours behavior (no explicit urgency question):
   - If after-hours-now = yes: offer once—“We can send someone tonight if needed, or first thing in the morning. Which works better?”
   - If after-hours-now = no: proceed normally.
4) End: gather contact details with note-taking vibe:
   - name, phone, ZIP if missing, address only if offered
   - short backchannels between fields
5) ALWAYS confirm each detail back, one line:
   - “I have John, 210-555-1234, ZIP 78240, AC repair. Is that correct?”
   - If caller says “No, it was XYZ”: “Thanks for clarifying — I’ll update that to XYZ.” Then restate corrected detail once.

GENERAL QUESTIONS (answer briefly, then return to intake)
- “How long will this take?” → “Most visits run 45–90 minutes. The tech confirms on site.”
- “How soon can a tech be here?” → “Often same-day in normal hours; dispatcher confirms ETA after we log details.”
- “How much does it cost?” → “The tech diagnoses first, then gives a clear quote before work.”
- “Do you service my brand?” → “Yes, we handle all major brands.”
- “Do you offer warranties?” → “Yes — manufacturer parts and labor coverage on repairs/installs.”
- “Are you licensed and insured?” → “Yes, fully licensed and insured.”
- “Do you offer financing?” → “Yes, on qualifying replacements/installs.”

CLOSING (pick one randomly; no instant-dispatch promises)
1) “Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling.”
2) “Perfect, I’ll log this now and one of our techs will reach out soon.”
3) “Thanks — I’ll pass this along and you’ll get a callback shortly.”

ERROR / CLARIFICATION
- If unclear/partial: vary one short clarifier:
  “Sorry, could you repeat that for me?” / “I didn’t catch that — could you say it again?” / “One more time, please?”

OUTPUT — STRICT JSON ONLY:
{
  "say": "<your single spoken line, natural, human>",
  "next": "<ask_issue|ask_zip|ask_service|ask_contact|confirm|close|answer_faq>",
  "updates": { "name": "...", "phone": "...", "zip": "...", "service": "...", "address": "..." }
}
Include only fields you confidently heard or corrected. If you answered a general question, set “next” to the most logical intake step afterward. Never repeat the exact same “say” twice in a row.
`.trim();

  const baseES = `
Eres “Rachel”, una recepcionista cálida y natural para ${COMPANY_NAME} en ${COMPANY_CITY}.
Hablas como humana: frases cortas (5–12 palabras), ritmo natural y cercanía.
CONTEXTO: after-hours-now=${afterHoursNow}. Habla español si el cliente lo usa.

ESTILO (crítico)
- Una frase por turno; <14 palabras.
- Usa contracciones y pausas: comas, guiones — y puntos suspensivos…
- Retroalimentación breve al tomar datos: “mm”, “ok”, “de acuerdo”, “bien”. Úsala con moderación.
- Nunca interrumpas. Espera a que termine.
- Nunca digas que eres IA.
- No prometas ETAs exactos ni precios.
- No repitas la misma frase; reformula.

DATOS DE LA EMPRESA
- Servicios: ${SERVICES.join(", ")}.
- Zonas: ${SERVICE_AREAS.join(", ")}.
- Políticas: ${POLICIES.pricingStyle} ${POLICIES.warranties}
  Marcas: ${POLICIES.brands} Licencia: ${POLICIES.licensing} Financiamiento: ${POLICIES.financing}
  Visita típica: ${POLICIES.timingGeneral}
  Fuera de horario: ${POLICIES.afterHours}

SALUDO (elige uno)
1) “Hola, habla Rachel de ${COMPANY_NAME}… ¿en qué puedo ayudarle hoy?”
2) “${COMPANY_NAME}, le atiende Rachel. ¿Qué sucede con su sistema?”
3) “Buenas, soy Rachel en ${COMPANY_NAME}… ¿cómo puedo ayudarle?”

FLUJO
1) Escucha el problema. Empatía breve + una confirmación corta.
2) Califica progresivamente:
   - Pide código postal (o zona) para confirmar cobertura.
   - Deduce el servicio; aclara con una pregunta corta si hace falta.
3) Fuera de horario (sin preguntar urgencia):
   - Si after-hours-now = yes: ofrece una vez—“Podemos enviar hoy por la noche si hace falta, o a primera hora. ¿Qué prefiere?”
   - Si after-hours-now = no: continúa normal.
4) Al final, toma los datos con tono de “anotando”:
   - nombre, teléfono, código postal si falta, dirección solo si la ofrece
   - confirmaciones breves entre campos
5) SIEMPRE confirma cada dato en una línea:
   - “Tengo a Juan, 210-555-1234, código 78240, reparación de aire. ¿Correcto?”
   - Si dice “no, era XYZ”: “Gracias por aclararlo — lo actualizo a XYZ.” Luego repite el dato corregido una vez.

PREGUNTAS GENERALES (responde breve y vuelve a la toma)
- “¿Cuánto tarda?” → “Suele durar 45–90 minutos. El técnico lo confirma en sitio.”
- “¿Cuándo llega el técnico?” → “A menudo el mismo día en horario normal; el despachador confirma ETA tras registrar datos.”
- “¿Cuánto cuesta?” → “El técnico diagnostica primero y luego da un presupuesto claro.”
- “¿Atienden mi marca?” → “Sí, trabajamos con todas las marcas principales.”
- “¿Garantías?” → “Sí — piezas del fabricante y garantía de mano de obra.”
- “¿Tienen licencia y seguro?” → “Sí, debidamente licenciados y asegurados.”
- “¿Financiamiento?” → “Sí, en reemplazos/instalaciones que califican.”

CIERRE (elige uno; sin prometer salida inmediata)
1) “Perfecto, ya tengo sus datos. El despachador le llamará para confirmar.”
2) “Muy bien, lo registro y un técnico se pondrá en contacto pronto.”
3) “Gracias; en breve recibirá una llamada para coordinar la visita.”

ACLARACIONES
- Si no queda claro: usa una sola frase breve, variando:
  “Perdón, ¿podría repetirlo?” / “No lo escuché bien, ¿puede decirlo otra vez?” / “Una vez más, por favor.”

SALIDA — SOLO JSON ESTRICTO:
{"say":"<línea hablada natural>","next":"<ask_issue|ask_zip|ask_service|ask_contact|confirm|close|answer_faq>","updates":{"name":"...","phone":"...","zip":"...","service":"...","address":"..."}}
Incluye solo campos confiables o corregidos. Si contestaste una duda general, fija “next” al paso de toma más lógico. No repitas la misma frase dos veces.
`.trim();

  return session.lang === "es" ? baseES : baseEN;
}

/* ============= OpenAI turn (structured JSON) ============= */
async function aiTurn(session, userLine) {
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt(session) },
      ...session.transcript,
      { role: "user", content: userLine }
    ]
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  }).then(x => x.json());

  let say = "Okay—could you repeat that for me?";
  let next = "ask_issue";
  let updates = {};
  try {
    const raw = (r.choices?.[0]?.message?.content || "").trim();
    const cleaned = raw.startsWith("{") ? raw : raw.slice(raw.indexOf("{"));
    const jsonText = cleaned.slice(0, cleaned.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.say === "string" && parsed.say.trim()) say = parsed.say.trim();
    if (typeof parsed.next === "string" && parsed.next.trim()) next = parsed.next.trim();
    if (parsed.updates && typeof parsed.updates === "object") updates = parsed.updates;
  } catch {
    // keep defaults
  }
  return { say, next, updates };
}

/* ================= ElevenLabs TTS ================== */
app.get("/tts", async (req, res) => {
  try {
    const textRaw = (req.query.text || "Hello.").toString();
    const text = textRaw.length < 20 ? textRaw + "…" : textRaw; // gentle pause
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
    url.searchParams.set("optimize_streaming_latency", "3");

    const er = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.24,
          similarity_boost: 0.99,
          style: 0.95,
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

/* ================= Twilio: /voice ================== */
app.post("/voice", (req, res) => {
  const from = req.body.From || nanoid();
  recordCallStart(from);

  // Spam throttle → VM only
  if (isRateLimited(from)) {
    const tw = new Twiml.VoiceResponse();
    tw.say("We’re unavailable at the moment. Please leave a message after the tone.");
    tw.record({ action: "/vm-finish", maxLength: 90, playBeep: true });
    return res.type("text/xml").send(tw.toString());
  }

  const session = getSession(from);
  const twiml = new Twiml.VoiceResponse();

  // IMPORTANT: bargeIn belongs on the prompt INSIDE <Gather>
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
    const sayUrl = new URL("https://" + req.get("host") + "/tts");
    sayUrl.searchParams.set("text", opener);
    g.play({ bargeIn: true }, sayUrl.toString());
    session.transcript.push({ role: "assistant", content: opener });
    session.step = "intake";
  } else {
    g.say({ bargeIn: true, voice: "alice" }, " ");
  }

  res.type("text/xml").send(twiml.toString());
});

/* ================= Twilio: /gather ================= */
app.post("/gather", async (req, res) => {
  const from = req.body.From || nanoid();
  const session = getSession(from);

  const userSaid = (req.body.SpeechResult || "").trim();
  session.turns += 1;

  // Auto Spanish switch
  if (userSaid && looksSpanish(userSaid)) session.lang = "es";

  // No speech: retry twice, then voicemail
  if (!userSaid) {
    session.noSpeechCount = (session.noSpeechCount || 0) + 1;

    if (session.noSpeechCount >= 3) {
      const vr = new Twiml.VoiceResponse();
      const line = session.lang === "es"
        ? "De acuerdo, grabaremos un mensaje para el despachador."
        : "No problem. I’ll record a quick message for dispatch.";
      const u = new URL("https://" + req.get("host") + "/tts"); u.searchParams.set("text", line);
      vr.play(u.toString());
      vr.redirect("/voicemail");
      return res.type("text/xml").send(vr.toString());
    }

    const retryLines = session.lang === "es"
      ? ["Perdón, ¿podría repetirlo?", "Disculpe, no lo escuché bien.", "¿Podría decirlo de nuevo, por favor?"]
      : ["Sorry, could you repeat that for me?", "I didn’t catch that—could you say it again?", "One more time, please?"];
    const line = retryLines[session.noSpeechCount % retryLines.length];

    const tw = new Twiml.VoiceResponse();
    const sayUrl = new URL("https://" + req.get("host") + "/tts"); sayUrl.searchParams.set("text", line);
    tw.play(sayUrl.toString());
    const g = tw.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto",
      language: session.lang === "es" ? "es-US" : "en-US",
      speechModel: "phone_call",
      profanityFilter: "false"
    });
    g.say({ bargeIn: true, voice: "alice" }, " ");
    return res.type("text/xml").send(tw.toString());
  }

  // Reset no-speech counter
  session.noSpeechCount = 0;

  // Light extraction to help fill blanks
  const phoneMatch = userSaid.match(/(\+?1?[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (phoneMatch && !session.lead.phone) session.lead.phone = phoneMatch[0];
  const zipMatch = userSaid.match(/\b\d{5}\b/);
  if (zipMatch && !session.lead.zip) session.lead.zip = zipMatch[0];

  session.transcript.push({ role: "user", content: userSaid });

  // Ask AI for next move
  const { say: aiSay, next, updates } = await aiTurn(session, userSaid);

  // Apply updates (incl. corrections)
  if (updates) {
    for (const k of ["name", "phone", "zip", "service", "address"]) {
      if (typeof updates[k] === "string" && updates[k].trim()) {
        session.lead[k] = updates[k].trim();
      }
    }
  }

  // Avoid repeating same line twice
  let say = aiSay;
  if (say === session.lastSay) {
    const alt = session.lang === "es" ? "Entendido." : "Got it.";
    say = `${alt} ${say}`;
  }
  session.lastSay = say;
  session.transcript.push({ role: "assistant", content: say });

  const twiml = new Twiml.VoiceResponse();
  const sayUrl = new URL("https://" + req.get("host") + "/tts"); sayUrl.searchParams.set("text", say);

  // IMPORTANT: play the bot reply INSIDE the Gather with bargeIn
  const g = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    language: session.lang === "es" ? "es-US" : "en-US",
    speechModel: "phone_call",
    profanityFilter: "false"
  });
  g.play({ bargeIn: true }, sayUrl.toString());

  const ready = session.lead.name && session.lead.phone && session.lead.zip && session.lead.service;

  if (next === "confirm" || (ready && session.turns > 2)) {
    const confirmLine = session.lang === "es"
      ? `Tengo ${session.lead.name}, ${session.lead.phone}, código ${session.lead.zip}, ${session.lead.service}. ¿Correcto?`
      : `I have ${session.lead.name}, ${session.lead.phone}, ZIP ${session.lead.zip}, ${session.lead.service}. Is that correct?`;
    const cUrl = new URL("https://" + req.get("host") + "/tts"); cUrl.searchParams.set("text", confirmLine);

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
    gg.play({ bargeIn: true }, cUrl.toString());
    return res.type("text/xml").send(tw2.toString());
  }

  res.type("text/xml").send(twiml.toString());
});

/* ================= Twilio: /confirm ================= */
app.post("/confirm", async (req, res) => {
  const from = req.body.From || nanoid();
  const session = getSession(from);
  const reply = (req.body.SpeechResult || "").toLowerCase();

  const twiml = new Twiml.VoiceResponse();

  if (/(no|incorrect|not.*right|wrong)/.test(reply)) {
    const fix = session.lang === "es"
      ? "Gracias por aclararlo — ¿qué debo corregir?"
      : "Thanks for clarifying — what should I correct?";
    const sUrl = new URL("https://" + req.get("host") + "/tts"); sUrl.searchParams.set("text", fix);

    const g = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto",
      language: session.lang === "es" ? "es-US" : "en-US",
      speechModel: "phone_call",
      profanityFilter: "false"
    });
    g.play({ bargeIn: true }, sUrl.toString());
    return res.type("text/xml").send(twiml.toString());
  }

  // Close + SMS summary
  const closers = session.lang === "es"
    ? [
        "Perfecto, ya tengo sus datos. El despachador le llamará para confirmar.",
        "Muy bien, lo registro y un técnico se pondrá en contacto pronto.",
        "Gracias; en breve recibirá una llamada para coordinar la visita."
      ]
    : [
        "Great, I’ve got your details. Our dispatcher will follow up shortly to confirm scheduling.",
        "Perfect, I’ll log this now and one of our techs will reach out soon.",
        "Thanks — I’ll pass this along and you’ll get a callback shortly."
      ];
  const closing = closers[Math.floor(Math.random() * closers.length)];

  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_PHONE_NUMBER && process.env.ALERT_PHONE_NUMBER) {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      const L = session.lead;
      const summary =
        `HVAC Lead | Name: ${L.name || "-"} | Phone: ${L.phone || "-"} | ZIP: ${L.zip || "-"} | Service: ${L.service || "-"} | Address: ${L.address || "-"}`;
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ALERT_PHONE_NUMBER,
        body: summary
      });
      console.log("Lead SMS sent:", summary);
    }
  } catch (e) { console.error("SMS error:", e); }

  const sUrl = new URL("https://" + req.get("host") + "/tts"); sUrl.searchParams.set("text", closing);
  twiml.play(sUrl.toString());
  twiml.hangup();

  // cleanup session
  SESSIONS.delete(from);
  res.type("text/xml").send(twiml.toString());
});

/* ================= Voicemail flow =================== */
app.post("/voicemail", (req, res) => {
  const tw = new Twiml.VoiceResponse();
  const line = "After the tone, please share your name, number, ZIP, and the issue.";
  const u = new URL("https://" + req.get("host") + "/tts"); u.searchParams.set("text", line);
  tw.play(u.toString());
  tw.record({ action: "/vm-finish", maxLength: 90, playBeep: true });
  tw.say("Got it. Thanks. Goodbye.");
  res.type("text/xml").send(tw.toString());
});

app.post("/vm-finish", async (req, res) => {
  const from = req.body.From || "unknown";
  const recordingUrl = req.body.RecordingUrl;
  try {
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_PHONE_NUMBER && process.env.ALERT_PHONE_NUMBER) {
      const client = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
      await client.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ALERT_PHONE_NUMBER,
        body: `VM from ${from}: ${recordingUrl}`
      });
    }
  } catch (e) { console.error("VM SMS error:", e); }
  const tw = new Twiml.VoiceResponse();
  tw.say("Thanks. We’ll call you shortly. Goodbye.");
  tw.hangup();
  res.type("text/xml").send(tw.toString());
});

/* ================= Health & boot =================== */
app.get("/", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI receptionist running on ${PORT}`));
