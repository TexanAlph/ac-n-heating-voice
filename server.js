import express from "express";
import bodyParser from "body-parser";
import { twiml as Twiml } from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Health check
app.get("/", (_, res) => res.send("OK"));

// Voice webhook endpoint
app.post("/voice", (req, res) => {
  const twiml = new Twiml.VoiceResponse();

  // Placeholder greeting for now
  twiml.say(
    { voice: "alice" },
    "Thanks for calling AC-N-Heating. Our receptionist is being set up. Please call back soon."
  );
  twiml.hangup();

  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
