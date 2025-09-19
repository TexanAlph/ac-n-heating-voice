// server.js
import express from "express";
import bodyParser from "body-parser";
import pkg from "twilio";

const { twiml: Twiml, Twilio } = pkg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio setup
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM_SMS = process.env.TWILIO_NUMBER;
const TO_SMS = "+12104781836"; // Your cell
const twilioClient = new Twilio(TWILIO_SID, TWILIO_AUTH);

// Session tracker
const sessions = {};

// State flow order
const STATES = ["problem", "name", "phone", "address", "zip", "confirm", "close"];

// Helper: get next state
function getNextState(current) {
  const idx = STATES.indexOf(current);
  return idx >= 0 && idx < STATES.length - 1 ? STATES[idx + 1] : "close";
}

// Helper: get question for each state
function getQuestion(state, data = {}) {
  switch (state) {
    case "problem":
      return "Hi, this is Rachel with AC and Heating. How can I help you today?";
    case "name":
      return "Mhm, okay, I got you. Can I have your name please?";
    case "phone":
      return "Thanks. What’s the best number to reach you?";
    case "address":
      return "And what’s the service address?";
    case "zip":
      return "And the ZIP code there?";
    case "confirm":
      return `So I have ${data.name || "?"}, ${data.phone || "?"}, ${data.address || "?"}, ZIP ${data.zip || "?"}. Is that correct?`;
    case "close":
      return "Perfect, I’ve got everything noted. Dispatch will call you shortly. Goodbye.";
    default:
      return "Okay, thank you. Goodbye.";
  }
}

// Twilio: entry point
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;
  sessions[callSid] = { state: "problem", data: {} };

  const twiml = new Twiml.VoiceResponse();
  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto"
  });
  gather.say(getQuestion("problem"), { voice: "alice" });

  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle responses
app.post("/gather", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || "";
  const session = sessions[callSid];

  if (!session) {
    const twiml = new Twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Goodbye.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Save response by state
  if (session.state !== "confirm" && session.state !== "close") {
    session.data[session.state] = speech;
  }

  // Move state forward
  session.state = getNextState(session.state);

  // Build next question
  const twiml = new Twiml.VoiceResponse();
  if (session.state === "close") {
    twiml.say(getQuestion("close"), { voice: "alice" });

    // Send SMS summary
    const summary = `
New HVAC Call:
Problem: ${session.data.problem || "?"}
Name: ${session.data.name || "?"}
Phone: ${session.data.phone || "?"}
Address: ${session.data.address || "?"}
ZIP: ${session.data.zip || "?"}
    `;
    twilioClient.messages.create({
      body: summary,
      from: FROM_SMS,
      to: TO_SMS
    }).catch(err => console.error("SMS failed:", err));

  } else {
    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto"
    });
    gather.say(getQuestion(session.state, session.data), { voice: "alice" });
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`AI receptionist running on ${PORT}`);
});
