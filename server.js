// server.js
import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { twiml as Twiml } from "twilio";
import twilio from "twilio";
import * as b64 from "base64-js";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// -------- Config --------
const PORT = process.env.PORT || 10000;
const OPENAI_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17"; // Realtime WS
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SMS_TO = process.env.ALERT_SMS_TO || "";
const SMS_FROM = process.env.ALERT_SMS_FROM || "";

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// -------- Small helpers --------
const now = () => new Date().toISOString();

// μ-law <-> PCM16
// Based on ITU G.711 μ-law
function muLawDecode(uVal) {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  let exponent = (uVal >> 4) & 0x07;
  let mantissa = uVal & 0x0f;
  let sample =
    ((mantissa << 4) + 0x08) << (exponent + 3); // 16-bit magnitude
  sample -= 0x84; // bias
  return (sign ? -sample : sample) | 0;
}
function muLawEncode(pcmVal) {
  const BIAS = 0x84;
  let mask;
  let sign = (pcmVal >> 8) & 0x80;
  if (sign !== 0) pcmVal = -pcmVal;
  pcmVal += BIAS;
  if (pcmVal > 0x7fff) pcmVal = 0x7fff;

  let exponent = 7;
  for (let expMask = 0x4000; (pcmVal & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (pcmVal >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  let uVal = ~(sign | (exponent << 4) | mantissa);
  return uVal & 0xff;
}

// Linear resampler PCM16 mono
function resamplePCM16(int16Array, inRate, outRate) {
  if (inRate === outRate) return int16Array;
  const ratio = outRate / inRate;
  const outLength = Math.floor(int16Array.length * ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, int16Array.length - 1);
    const frac = srcIndex - i0;
    out[i] = (int16Array[i0] * (1 - frac) + int16Array[i1] * frac) | 0;
  }
  return out;
}

// Convert base64 μ-law -> base64 PCM16 (16kHz)
function ulawB64ToPcm16B64_16k(b64In) {
  const bytes = b64.toByteArray(b64In);
  const pcm8k = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) pcm8k[i] = muLawDecode(bytes[i]);
  const pcm16k = resamplePCM16(pcm8k, 8000, 16000);
  const buf = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  return buf.toString("base64");
}

// Convert PCM16 (possibly 16k) -> μ-law 8k b64 for Twilio playback
function pcm16ToUlawB64FromPCM16Int16(int16, inRate = 16000) {
  const pcm8k = resamplePCM16(int16, inRate, 8000);
  const out = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) out[i] = muLawEncode(pcm8k[i]);
  return b64.fromByteArray(out);
}
function pcm16B64ToInt16(b64In) {
  const bytes = b64.toByteArray(b64In);
  // Little-endian int16
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// -------- TwiML route: start bidirectional Stream --------
app.post("/twiml", (req, res) => {
  const vr = new Twiml.VoiceResponse();

  // Announce quickly so the line isn’t dead-silent
  vr.say({ voice: "Polly.Joanna", language: "en-US" }, "Connecting you now.");

  const connect = vr.connect();
  const stream = connect.stream({
    url: `wss://${req.headers.host}/media`, // Render gives valid cert
  });
  // pass useful metadata to websocket
  stream.parameter({ name: "from", value: req.body.From || "" });
  stream.parameter({ name: "to", value: req.body.To || "" });
  stream.parameter({ name: "callSid", value: req.body.CallSid || "" });

  res.type("text/xml").send(vr.toString());
});

// -------- WebSocket server to receive Twilio media --------
const wss = new WebSocketServer({ noServer: true });

/**
 * Per-call bridge state
 */
class Bridge {
  constructor(twilioWs, startMsg) {
    this.twilioWs = twilioWs;
    this.streamSid = startMsg.streamSid;
    this.from = startMsg.start?.customParameters?.From || startMsg.start?.customParameters?.from || "";
    this.to = startMsg.start?.customParameters?.To || startMsg.start?.customParameters?.to || "";
    this.callSid = startMsg.start?.callSid || "";

    this.summaryTexts = []; // transcripts to text you later
    this.openaiWs = null;
    this.openaiOutputSampleRate = 16000; // we’ll request 16k
    this.markCounter = 0;

    this._initOpenAI();
  }

  _initOpenAI() {
    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    };
    this.openaiWs = new WebSocket(OPENAI_WS_URL, { headers });

    // Keepalive for Realtime (respond to pings)
    this.openaiWs.on("ping", () => {
      this.openaiWs.pong();
    });

    this.openaiWs.on("open", () => {
      // Configure session once connected
      const sessionUpdate = {
        type: "session.update",
        session: {
          // Voice & behavior
          voice: "verse", // natural female; you can try "alloy", "sol", etc.
          instructions: [
            "You are Rachel from AC & Heating in San Antonio, a warm, calm, highly competent dispatcher.",
            "Speak naturally with short pauses, occasional 'mm-hmm', 'got it', 'okay', but don’t overdo it.",
            "Never cut the caller off; if they start talking while you are, stop and listen.",
            "Flow: 1) Greet: 'Hi, this is Rachel with AC and Heating — how can I help today?'.",
            "2) Listen for issue category: repair, maintenance, or new system.",
            "3) Reflect briefly: 'mm-hm, okay gotcha.'",
            "4) Ask focused follow-ups about the issue (symptoms, age of system, thermostat/filters tried).",
            "5) Collect contact info in this exact order: name, phone, service address.",
            "6) Only then, timing: if after-hours, say we can dispatch after-hours (fee may apply); otherwise offer next available window.",
            "If asked something you don’t know, say you'll note it for the technician.",
            "Never promise exact ETAs. If asked 'how soon', say: 'We’ll prioritize you and confirm the window by text shortly.'",
            "At wrap-up, confirm: issue, name, phone, address, and preferred time window.",
            "Tone is friendly and efficient, never robotic."
          ].join(" "),
          // Server-side VAD = no manual commit loops
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 400, create_response: true },
          // Ask for transcriptions so we can text a summary later
          input_audio_transcription: { model: "whisper-1" },
          // Ensure audio I/O is raw PCM16; we’ll resample to 8k u-law for Twilio playback
          input_audio_format: "pcm16",
          output_audio_format: "pcm16"
        }
      };
      this.openaiWs.send(JSON.stringify(sessionUpdate));
    });

    // Handle messages from OpenAI
    this.openaiWs.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // When caller starts talking, cut any buffered playback
      if (msg.type === "input_audio_buffer.speech_started") {
        this._twilioClear();
        return;
      }

      // Gather transcripts to text you later
      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
        this.summaryTexts.push(`[Caller] ${msg.transcript}`);
        return;
      }

      // Stream audio back to Twilio as μ-law/8000
      if (msg.type === "response.audio.delta" && msg.delta) {
        // delta is base64 PCM16 at model’s output rate (we asked for 16k)
        const int16 = pcm16B64ToInt16(msg.delta);
        const ulawB64 = pcm16ToUlawB64FromPCM16Int16(int16, this.openaiOutputSampleRate);
        this._twilioMedia(ulawB64);
        return;
      }

      // When a model message finishes, mark so Twilio knows playback point
      if (msg.type === "response.audio.done" || msg.type === "response.done") {
        this._twilioMark();
        return;
      }

      // Some servers announce the session with sample rate details
      if (msg.type === "session.created" && msg.session?.output_audio_format?.sample_rate_hz) {
        this.openaiOutputSampleRate = msg.session.output_audio_format.sample_rate_hz;
      }

      // If there’s model text output, save it, too
      if (msg.type === "response.text.delta" && msg.delta) {
        this.summaryTexts.push(`[Agent] ${msg.delta}`);
      }
    });

    this.openaiWs.on("close", () => {
      // nothing special
    });

    this.openaiWs.on("error", (err) => {
      console.error(`${now()} OpenAI WS error`, err?.message || err);
    });
  }

  // Send media to Twilio (server -> caller)
  _twilioMedia(base64Ulaw) {
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: base64Ulaw },
        })
      );
    }
  }

  _twilioMark() {
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.send(
        JSON.stringify({
          event: "mark",
          streamSid: this.streamSid,
          mark: { name: `m_${++this.markCounter}` },
        })
      );
    }
  }

  _twilioClear() {
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.send(
        JSON.stringify({
          event: "clear",
          streamSid: this.streamSid,
        })
      );
    }
  }

  // Receive Twilio frames -> forward to OpenAI
  handleTwilioMessage(obj) {
    switch (obj.event) {
      case "start":
        // no-op beyond constructor capture
        break;
      case "media": {
        if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
        const pcm16b64 = ulawB64ToPcm16B64_16k(obj.media.payload);
        // No need to commit manually; server VAD will commit/turn-take
        this.openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm16b64,
          })
        );
        break;
      }
      case "dtmf":
        // ignore
        break;
      case "stop":
        this.finishAndTextSummary();
        break;
      default:
        break;
    }
  }

  async finishAndTextSummary() {
    try {
      if (twilioClient && SMS_TO && SMS_FROM && this.summaryTexts.length) {
        const header = `☎️ AC & Heating call summary\nFrom: ${this.from || "Unknown"}\nTo: ${this.to || "Your line"}\n${now()}\n\n`;
        const body = header + this.summaryTexts.join("\n").slice(0, 1300); // keep under SMS split
        await twilioClient.messages.create({
          to: SMS_TO,
          from: SMS_FROM,
          body,
        });
      }
    } catch (e) {
      console.error(`${now()} SMS summary error`, e?.message || e);
    }
  }
}

// Accept Twilio’s WebSocket upgrade at /media
const server = app.listen(PORT, () => {
  console.log(`AI receptionist running on ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws /*, req */) => {
  let bridge = null;

  ws.on("message", (msg) => {
    let obj;
    try { obj = JSON.parse(msg.toString()); } catch { return; }

    if (obj.event === "connected") {
      // Twilio connected
    } else if (obj.event === "start") {
      // create per-call bridge
      bridge = new Bridge(ws, obj);
    } else if (bridge) {
      bridge.handleTwilioMessage(obj);
    }
  });

  ws.on("close", () => {
    // ended
  });

  ws.on("error", (err) => {
    console.error(`${now()} Twilio WS error`, err?.message || err);
  });
});
