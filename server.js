import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const { twiml: Twiml } = twilio;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// -------- Config --------
const PORT = process.env.PORT || 10000;
const OPENAI_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SMS_TO = process.env.ALERT_SMS_TO || "";
const SMS_FROM = process.env.ALERT_SMS_FROM || "";
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const now = () => new Date().toISOString();

// -------- Base64 helpers (Node Buffer) --------
const b64ToBuffer = (b64) => Buffer.from(b64, "base64");
const bufferToB64 = (buf) => Buffer.from(buf).toString("base64");

// -------- G.711 μ-law <-> PCM16 and resampling --------
function muLawDecode(uVal) {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  let exponent = (uVal >> 4) & 0x07;
  let mantissa = uVal & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84;
  return (sign ? -sample : sample) | 0;
}
function muLawEncode(pcmVal) {
  const BIAS = 0x84;
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
function int16ArrayToBufferLE(int16Array) {
  const buf = Buffer.alloc(int16Array.length * 2);
  for (let i = 0; i < int16Array.length; i++) {
    buf.writeInt16LE(int16Array[i], i * 2);
  }
  return buf;
}
function ulawBufferToPcm16Buffer16k(ulawBuffer) {
  const pcm8k = new Int16Array(ulawBuffer.length);
  for (let i = 0; i < ulawBuffer.length; i++) pcm8k[i] = muLawDecode(ulawBuffer[i]);
  const pcm16k = resamplePCM16(pcm8k, 8000, 16000);
  return int16ArrayToBufferLE(pcm16k);
}
function pcm16B64ToInt16(b64In) {
  const buf = b64ToBuffer(b64In);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Int16Array(buf.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
function pcm16ToUlawB64FromPCM16Int16(int16, inRate = 16000) {
  const pcm8k = resamplePCM16(int16, inRate, 8000);
  const out = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) out[i] = muLawEncode(pcm8k[i]);
  return bufferToB64(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
}

// -------- TwiML: start a Media Stream to /media --------
app.post("/twiml", (req, res) => {
  const vr = new Twiml.VoiceResponse();
  vr.say(
    { voice: "alice", language: "en-US" },
    "Hi, this is Rachel with AC and Heating. How can I help you today?"
  );

  if (!OPENAI_API_KEY) {
    vr.pause({ length: 1 });
    vr.say({ voice: "alice", language: "en-US" }, "Sorry, something went wrong. Please call again.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
    return;
  }

  const connect = vr.connect();
  const stream = connect.stream({ url: `wss://${req.headers.host}/media` });
  // pass metadata (optional)
  if (req.body.From) stream.parameter({ name: "from", value: req.body.From });
  if (req.body.To) stream.parameter({ name: "to", value: req.body.To });
  if (req.body.CallSid) stream.parameter({ name: "callSid", value: req.body.CallSid });
  res.type("text/xml").send(vr.toString());
});

// -------- WS server to accept Twilio Media Stream --------
const wss = new WebSocketServer({ noServer: true });

class Bridge {
  constructor(twilioWs, startMsg) {
    this.twilioWs = twilioWs;
    this.streamSid = startMsg.streamSid;
    this.from = ""; this.to = ""; this.callSid = "";
    try {
      const cp = startMsg.start?.customParameters || [];
      for (const p of cp) {
        if (p.name?.toLowerCase() === "from") this.from = p.value;
        if (p.name?.toLowerCase() === "to") this.to = p.value;
        if (p.name?.toLowerCase() === "callsid") this.callSid = p.value;
      }
    } catch {}
    this.summaryTexts = [];
    this.openaiWs = null;
    this.openaiOutputSampleRate = 16000;
    this.openaiReady = false;
    this.fallbackTriggered = false;
    this.closedByStop = false;
    this.warnedOpenAiNotReady = false;
    this.bytesSinceCommit = 0;
    this.commitThresholdBytes = 16000; // ~0.5s of 16kHz PCM16 audio
    this.commitSilenceMs = 750;
    this.commitTimer = null;
    this.repromptedAfterMisunderstanding = false;
    this.twilioChunkCount = 0;
    this.openAiAudioChunkCount = 0;
    this.lastResponseIdLogged = null;

    console.log(
      `${now()} Connected to Twilio stream ${this.streamSid} (callSid: ${this.callSid || "unknown"})`
    );

    if (!OPENAI_API_KEY) {
      this._sendFallbackAndClose("Missing OPENAI_API_KEY");
      return;
    }

    this._initOpenAI();
  }

  _initOpenAI() {
    try {
      const headers = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      };
      this.openaiWs = new WebSocket(OPENAI_WS_URL, { headers });
    } catch (err) {
      this._sendFallbackAndClose(`Failed to init OpenAI WebSocket: ${err?.message || err}`);
      return;
    }

    this.openaiWs.on("open", () => {
      this.openaiReady = true;
      this.warnedOpenAiNotReady = false;
      console.log(`${now()} Connected to OpenAI Realtime for stream ${this.streamSid}`);

      const sessionUpdate = {
        type: "session.update",
        session: {
          voice: "verse",
          instructions: [
            "You are Rachel with AC & Heating (San Antonio).",
            "Speak naturally, never interrupt; add light backchannels like 'mm-hm', 'okay', 'got it'.",
            "Flow: 1) Greet: 'Hi, this is Rachel with AC and Heating — how can I help you today?'.",
            "2) Listen for the problem and classify: repair, maintenance, or new system.",
            "3) Briefly acknowledge ('mm-hm, okay, gotcha'). Ask a short follow-up if needed.",
            "4) Then collect CONTACT INFO in this exact order: name, phone, address (include ZIP).",
            "5) If caller asks prices/financing/warranty/brands, say you'll note it for the technician.",
            "6) Confirm captured info once near the end; if any detail is wrong, re-ask only that piece.",
            "7) Close naturally: 'Perfect, I’ll pass this along and dispatch will follow up shortly.'",
            "If silence continues, wait calmly; do not keep repeating 'could you repeat that?'.",
            "Keep responses concise; avoid sounding robotic."
          ].join(" "),
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 250,
            silence_duration_ms: 500,
            create_response: false
          },
          input_audio_transcription: { model: "whisper-1" },
          input_audio_format: "pcm16",
          output_audio_format: "pcm16"
        }
      };
      this.openaiWs.send(JSON.stringify(sessionUpdate));

      this._requestOpenAIResponse(
        "Hi, this is Rachel with AC and Heating — how can I help you today?"
      );
    });

    this.openaiWs.on("ping", () => {
      if (this.openaiWs?.readyState === WebSocket.OPEN) {
        this.openaiWs.pong();
      }
    });

    this.openaiWs.on("message", (buf) => {
      if (this.fallbackTriggered) return;
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (err) {
        console.error(`${now()} Failed to parse OpenAI message:`, err);
        return;
      }

      if (msg.type === "session.created" && msg.session?.output_audio_format?.sample_rate_hz) {
        this.openaiOutputSampleRate = msg.session.output_audio_format.sample_rate_hz;
        return;
      }

      if (msg.type === "conversation.item.input_audio_transcription.failed") {
        const reason = msg.error?.message || "unknown transcription issue";
        this._handleMisunderstanding(`Transcription failed: ${reason}`);
        return;
      }

      if (msg.type === "response.error") {
        const reason = msg.error?.message || "unknown response error";
        this._handleMisunderstanding(`OpenAI response error: ${reason}`);
        return;
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
        this.summaryTexts.push(`[Caller] ${msg.transcript}`);
        this.repromptedAfterMisunderstanding = false;
        return;
      }
      if (msg.type === "response.text.delta" && msg.delta) {
        this.summaryTexts.push(`[Rachel] ${msg.delta}`);
        return;
      }

      if (msg.type === "response.audio.delta" && msg.delta) {
        if (msg.response_id && msg.response_id !== this.lastResponseIdLogged) {
          this.lastResponseIdLogged = msg.response_id;
          this.openAiAudioChunkCount = 0;
          console.log(`${now()} OpenAI started audio response ${msg.response_id} for stream ${this.streamSid}`);
        }
        const int16 = pcm16B64ToInt16(msg.delta);
        this.openAiAudioChunkCount += 1;
        const pcmBytes = int16.length * 2;
        console.log(`${now()} OpenAI audio chunk #${this.openAiAudioChunkCount} (${pcmBytes} bytes PCM16) for stream ${this.streamSid}`);
        const ulawB64 = pcm16ToUlawB64FromPCM16Int16(int16, this.openaiOutputSampleRate);
        this._twilioMedia(ulawB64);
        return;
      }

      if (msg.type === "response.audio.done" || msg.type === "response.done") {
        console.log(`${now()} OpenAI finished audio response for stream ${this.streamSid}`);
        this._twilioMark();
        return;
      }
    });

    this.openaiWs.on("error", (e) => {
      const msg = e?.message || e;
      console.error(`${now()} OpenAI WS error for stream ${this.streamSid}:`, msg);
      this._sendFallbackAndClose(`OpenAI error: ${msg}`);
    });

    this.openaiWs.on("close", (code, reason) => {
      this.openaiReady = false;
      console.log(
        `${now()} OpenAI WS closed for stream ${this.streamSid} (code: ${code || ""}${reason ? ` reason: ${reason}` : ""})`
      );
      if (!this.fallbackTriggered && !this.closedByStop) {
        this._sendFallbackAndClose("OpenAI connection closed unexpectedly");
      }
    });
  }

  // Send audio to Twilio
  _twilioMedia(base64Ulaw) {
    if (this.fallbackTriggered) return;
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      console.log(`${now()} Forwarding OpenAI audio chunk to Twilio for stream ${this.streamSid}`);
      this.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: base64Ulaw }
      }));
    }
  }
  _twilioMark() {
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.send(JSON.stringify({
        event: "mark",
        streamSid: this.streamSid,
        mark: { name: `m_${Date.now()}` }
      }));
    }
  }

  _clearCommitTimer() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  _scheduleCommit() {
    if (this.fallbackTriggered) return;
    this._clearCommitTimer();
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this._commitAudioBuffer({ force: true });
    }, this.commitSilenceMs);
  }

  _requestOpenAIResponse(instructions = "continue conversation naturally") {
    if (this.fallbackTriggered) return;
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    console.log(
      `${now()} Requesting OpenAI response for stream ${this.streamSid} (${instructions})`
    );
    this.openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"], instructions }
      })
    );
  }

  _commitAudioBuffer({ force = false, requestResponse = true } = {}) {
    if (this.fallbackTriggered) return;
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;
    const bytesToCommit = this.bytesSinceCommit;
    if (bytesToCommit === 0) {
      if (force) {
        console.log(
          `${now()} Commit requested for stream ${this.streamSid} but no caller audio buffered`
        );
      }
      return;
    }
    this._clearCommitTimer();
    console.log(`${now()} Committing ${bytesToCommit} bytes of caller audio to OpenAI for stream ${this.streamSid}`);
    this.openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.bytesSinceCommit = 0;
    if (requestResponse) {
      this._requestOpenAIResponse();
    }
  }

  _handleMisunderstanding(reason) {
    console.warn(`${now()} OpenAI could not understand caller audio for stream ${this.streamSid}: ${reason}`);
    if (!this.repromptedAfterMisunderstanding) {
      this.repromptedAfterMisunderstanding = true;
      this._requestOpenAIResponse(
        "I didn't quite catch that, but I'd love to help. Could you share that once more?"
      );
    }
  }

  _sendFallbackAndClose(reason) {
    if (this.fallbackTriggered) return;
    this.fallbackTriggered = true;
    this.closedByStop = true;
    this.openaiReady = false;
    this._clearCommitTimer();
    console.error(`${now()} Triggering fallback for stream ${this.streamSid}: ${reason}`);

    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      try {
        this.openaiWs.close(1011, "fallback");
      } catch (err) {
        console.error(`${now()} Failed to close OpenAI socket cleanly:`, err?.message || err);
      }
    }

    const fallbackTwiml = "<Response><Say>Sorry, something went wrong. Please call again.</Say></Response>";
    if (twilioClient && this.callSid) {
      twilioClient
        .calls(this.callSid)
        .update({ twiml: fallbackTwiml })
        .then(() => {
          console.log(`${now()} Fallback TwiML sent to call ${this.callSid}`);
        })
        .catch((err) => {
          console.error(`${now()} Failed to send fallback TwiML:`, err?.message || err);
        });
    } else {
      console.warn(
        `${now()} Cannot send fallback TwiML (missing Twilio credentials or callSid) for stream ${this.streamSid}`
      );
    }

    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      try {
        this.twilioWs.close(1011, "fallback");
      } catch (err) {
        console.error(`${now()} Failed to close Twilio socket cleanly:`, err?.message || err);
      }
    }
  }

  // Twilio -> OpenAI
  handleTwilioMessage(obj) {
    switch (obj.event) {
      case "start":
        // created by constructor
        break;
      case "media": {
        if (this.fallbackTriggered) return;
        if (!this.openaiReady || !this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) {
          if (!this.warnedOpenAiNotReady) {
            console.warn(`${now()} OpenAI socket not ready for stream ${this.streamSid}, dropping audio frame.`);
            this.warnedOpenAiNotReady = true;
          }
          return;
        }
        if (!obj.media?.payload) {
          console.warn(`${now()} Received Twilio media event without payload for stream ${this.streamSid}`);
          return;
        }
        const ulawBuffer = b64ToBuffer(obj.media.payload);
        this.twilioChunkCount += 1;
        console.log(
          `${now()} Twilio audio chunk #${this.twilioChunkCount} received for stream ${this.streamSid} (${ulawBuffer.length} bytes μ-law)`
        );
        const pcm16Buffer = ulawBufferToPcm16Buffer16k(ulawBuffer);
        console.log(
          `${now()} Converted chunk #${this.twilioChunkCount} to PCM16/16kHz (${pcm16Buffer.length} bytes) for stream ${this.streamSid}`
        );
        const pcm16b64 = bufferToB64(pcm16Buffer);
        console.log(
          `${now()} Sending PCM16 chunk #${this.twilioChunkCount} to OpenAI for stream ${this.streamSid}`
        );
        this.openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm16b64
        }));
        this.bytesSinceCommit += pcm16Buffer.length;
        console.log(
          `${now()} ${this.bytesSinceCommit} bytes of caller audio pending commit for stream ${this.streamSid}`
        );
        this._scheduleCommit();
        if (this.bytesSinceCommit >= this.commitThresholdBytes) {
          console.log(
            `${now()} Caller audio reached commit threshold for stream ${this.streamSid}`
          );
          this._commitAudioBuffer();
        }
        break;
      }
      case "stop":
        this.closedByStop = true;
        console.log(`${now()} Twilio stream ${this.streamSid} sent stop.`);
        this._clearCommitTimer();
        this._commitAudioBuffer({ force: true, requestResponse: false });
        if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
          try {
            this.openaiWs.close(1000, "twilio stop");
          } catch (err) {
            console.error(`${now()} Error closing OpenAI socket on stop:`, err?.message || err);
          }
        }
        this.finishAndTextSummary();
        break;
      case "connected":
      case "mark":
      case "dtmf":
      default:
        break;
    }
  }

  async finishAndTextSummary() {
    try {
      if (twilioClient && SMS_TO && SMS_FROM && this.summaryTexts.length) {
        const header = `☎️ AC & Heating call summary\nFrom: ${this.from || "Unknown"}  ->  ${this.to || "Your line"}\n${now()}\n\n`;
        const body = (header + this.summaryTexts.join("\n")).slice(0, 1400);
        await twilioClient.messages.create({ to: SMS_TO, from: SMS_FROM, body });
      }
    } catch (e) {
      console.error(`${now()} SMS error:`, e?.message || e);
    }
  }
}

// Upgrade HTTP → WS for /media
const server = app.listen(PORT, () => {
  console.log(`${now()} AI receptionist running on ${PORT}`);
});
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
wss.on("connection", (ws) => {
  console.log(`${now()} New Twilio media stream connected`);
  let bridge = null;
  ws.on("message", (msg) => {
    let obj;
    try { obj = JSON.parse(msg.toString()); } catch { return; }
    if (obj.event === "start") {
      bridge = new Bridge(ws, obj);
    } else if (bridge) {
      bridge.handleTwilioMessage(obj);
    }
  });
  ws.on("close", () => {
    if (bridge) {
      bridge._clearCommitTimer();
    }
  });
  ws.on("error", (e) => console.error(`${now()} Twilio WS error:`, e?.message || e));
});

export default app;
