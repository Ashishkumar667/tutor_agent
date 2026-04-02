require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const FormData = require("form-data");
const cors = require("cors");
const connectDB = require("./db");
const Session = require("./models/session");
const { retrieveRelevant } = require("./rag.utils");
const { v2: cloudinary } = require("cloudinary");
const streamifier = require("streamifier");
const app = express();
app.use(express.json());

const GROK_API_KEY      = process.env.GROK_API_KEY;
const GROK_BASE_URL     = "https://api.x.ai/v1";
const GROK_MODEL        = process.env.GROK_MODEL || "grok-4-1-fast-non-reasoning";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const UPLOADS_DIR = path.join(__dirname, "uploads");
const AUDIO_DIR   = path.join(__dirname, "audio_responses");
[UPLOADS_DIR, AUDIO_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`),
});
const upload = multer({
  storage: fileStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".txt", ".md"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `voice_${uuidv4()}${path.extname(file.originalname)}`),
});
const audioUpload = multer({ storage: audioStorage, limits: { fileSize: 10 * 1024 * 1024 } });

function uploadToCloudinary(buffer){
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video", 
        folder: "generated_audio",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".pdf") {
    const parsed = await pdfParse(fs.readFileSync(filePath));
    return parsed.text;
  }
  return fs.readFileSync(filePath, "utf-8");
}

function buildSystemPrompt(knowledgeBase, mode = "teach") {
  const personality = `
You are an enthusiastic, patient, and encouraging AI tutor named "Alex".
- Never hand over answers directly — guide the student to discover them
- Ask comprehension-check questions after each concept
- Celebrate correct answers and gently redirect mistakes
- Keep replies concise for natural spoken conversation (2–4 sentences unless explaining a concept)
- Use analogies and real-world examples when helpful
- If user ask anything..just say directly 'sorry, I can answer question related to your doc only.'
`.trim();

  if (mode === "teach") {
    return `${personality}

--- KNOWLEDGE BASE ---
${knowledgeBase}
--- END KNOWLEDGE BASE ---

TEACHING RULES:
1. Only use the knowledge base above — no outside material.
2. Start with a brief overview, then ask "Where would you like to start?" or begin from the top.
3. After each concept, ask a quick comprehension-check question.
4. Give hints, not full answers, when the student is stuck.
5. When all topics are covered say: "We've covered everything! Type 'quiz me' whenever you're ready."`;
  }

  return `${personality}

--- KNOWLEDGE BASE ---
${knowledgeBase}
--- END KNOWLEDGE BASE ---

QUIZ RULES:
1. You are in QUIZ MODE. Ask one question at a time.
2. Wait for the student's answer before continuing.
3. Give feedback after each answer, reveal the correct answer if wrong, then move on.
4. After all questions give a final score and encouraging summary.`;
}

async function callGrok(systemPrompt, history, retries = 2) {
  try{
  const res = await axios.post(
    `${GROK_BASE_URL}/chat/completions`,
    {
      model: GROK_MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      temperature: 0.7,
      max_tokens: 600,
    },
    { 
      headers: 
      { 
        Authorization: `Bearer ${GROK_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    timeout: 15000, 
  }
  );
  return res.data.choices[0].message.content.trim();
}catch(err){
    console.log("Grok Error:", err.code);

   if (retries > 0) {
      console.log("Retrying...");
      await new Promise(res => setTimeout(res, 1000));
      return callGrok(systemPrompt, history, retries - 1);
    }
  throw err;
}
}

async function textToSpeech(text, sessionId) {
 try {
   const res = await axios.post(
     "https://api.openai.com/v1/audio/speech",
     {
       model: "tts-1",
       input: text,
       voice: "alloy", 
       response_format: "mp3"
     },
     {
       headers: {
         Authorization: `Bearer ${OPENAI_API_KEY}`,
         "Content-Type": "application/json"
       },
       responseType: "arraybuffer",
     }
   );
   console.log("Audio buffer received, size:", res.data.length);
   return Buffer.from(res.data);
 } catch (error) {
   console.error("Error generating audio:", error);
   throw error;
 }
}

async function speechToText(audioFilePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(audioFilePath));
  form.append("model", "whisper-1");

  const res = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
  });
  return res.data.text;
}

async function generateQuizQuestions(knowledgeBase, count = 5) {
  const prompt = `Based on the following material, generate exactly ${count} quiz questions.
Return ONLY a valid JSON array — no markdown, no preamble:
[{ "question": "...", "answer": "..." }]

Material:
${knowledgeBase}`;

  const res = await axios.post(
    `${GROK_BASE_URL}/chat/completions`,
    { model: GROK_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.5, max_tokens: 1000 },
    { headers: { Authorization: `Bearer ${GROK_API_KEY}`, "Content-Type": "application/json" } }
  );

  let raw = res.data.choices[0].message.content.trim();
  console.log("Raw Grok quiz response:", raw);

  raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Grok did not return a JSON array. Raw response: ${raw}`);

  const parsed = JSON.parse(match[0]);

  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("Grok returned an empty or invalid quiz array.");

  const valid = parsed.filter(q => q && typeof q.question === "string" && typeof q.answer === "string");
  if (valid.length === 0)
    throw new Error("No valid question/answer pairs found in Grok response.");

  console.log(`Generated ${valid.length} quiz questions`);
  return valid;
}

function toGrokHistory(history) {
  return history.map(({ role, content }) => ({ role, content }));
}

function trimHistory(history, limit = 10) {
  return history.slice(-limit);
}

app.use(cors({
  origin: "*",
}));
app.use("/audio", express.static(AUDIO_DIR));


app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { file } = req.body; // URL string
    const rawFile = req.body.rawFile || req.body.fileData;
    const rawFileName = req.body.rawFileName || req.body.originalName || "raw.txt";
    let text = "";
    let fileName = "";

    if (req.file) {
      fileName = req.file.originalname;
      text = await extractText(req.file.path, req.file.originalname);
    } else if (rawFile) {
      fileName = rawFileName;
      let buffer;
      const rawText = String(rawFile).trim();
      if (rawText.startsWith("data:")) {
        const d = rawText.match(/^data:(.+?);base64,(.*)$/);
        if (!d) {
          return res.status(400).json({ error: "Invalid data URI in rawFile." });
        }
        buffer = Buffer.from(d[2], "base64");
      } else {
        const base64Candidate = rawText.replace(/\s+/g, "");
        const looksLikeBase64 = /^[A-Za-z0-9+/]+=*$/.test(base64Candidate) && base64Candidate.length % 4 === 0;
        if (looksLikeBase64) {
          try {
            buffer = Buffer.from(base64Candidate, "base64");
            if (buffer.toString("base64") !== base64Candidate) throw new Error("Not valid base64");
          } catch (err) {
            buffer = Buffer.from(rawText, "utf-8");
          }
        } else {
          buffer = Buffer.from(rawText, "utf-8");
        }
      }

      const ext = path.extname(fileName).toLowerCase();
      if (ext === ".pdf") {
        const parsed = await pdfParse(buffer);
        text = parsed.text;
      } else {
        text = buffer.toString("utf-8");
      }
    } else if (file) {
      const response = await axios.get(file, { responseType: "arraybuffer" });

      fileName = file;

      const contentType = response.headers["content-type"] || "";
      const cleanUrl = file.split("?")[0];
      const ext = path.extname(cleanUrl).toLowerCase();

      if (contentType.includes("pdf") || ext === ".pdf") {
        const parsed = await pdfParse(response.data);
        text = parsed.text;
      } else {
        text = response.data.toString("utf-8");
      }
    } else {
      return res.status(400).json({
        error: "Provide a multipart file, a URL in file field, or rawFile/fileData in request body.",
      });
    }

    // const text = await extractText(req.file.path, req.file.originalname);

    const { chunkText, createEmbeddings } = require("./rag.utils");

    const chunks = chunkText(text);
    const embeddedChunks = await createEmbeddings(chunks);

    const sessionId = req.body.sessionId || uuidv4();
    console.log("Chunks:", chunks.length);
    console.log("Embeddings created:", embeddedChunks.length);
    // Tutor greeting
    const greeting = await callGrok(buildSystemPrompt(text.slice(0, 2000), "teach"), [
      { role: "user", content: "Hi! I just uploaded my study material. Please greet me and give a short overview of what we'll be learning." },
    ]);

    // Upsert session in MongoDB
    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          sessionId,
          fileName: fileName,
          knowledgeChunks: embeddedChunks,
          mode: "teach",
          quizState: null,
          lastActiveAt: new Date(),
        },
        $push: {
          history: {
            $each: [
              { role: "user",      content: "Hi! I just uploaded my study material." },
              { role: "assistant", content: greeting, audioUrl: null },
            ],
          },
        },
      },
      { upsert: true, new: true }
    );

    const cleanPreview = text
    .replace(/\s+/g, " ")   // remove extra spaces + newlines
    .trim()
    .slice(0, 300);

    res.json({
      sessionId,
      message: "File uploaded successfully. Your tutor is ready!",
      fileName,
      previewText: cleanPreview + (text.length > 300 ? "..." : ""),
      tutorGreeting: greeting,
    });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "Failed to process file.", detail: err.message });
  }
});

app.post("/upload/raw", express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
  try {
    const rawBuffer = req.body;
    if (!rawBuffer || !Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
      return res.status(400).json({ error: "Raw data is required in the request body." });
    }

    const fileName = req.headers["x-filename"] || req.query.filename || `raw_${uuidv4()}.txt`;
    let text = "";
    const ext = path.extname(fileName).toLowerCase();

    if (ext === ".pdf") {
      const parsed = await pdfParse(rawBuffer);
      text = parsed.text;
    } else {
      text = rawBuffer.toString("utf-8");
    }

    const { chunkText, createEmbeddings } = require("./rag.utils");
    const chunks = chunkText(text);
    const embeddedChunks = await createEmbeddings(chunks);

    const sessionId = req.query.sessionId || req.headers["x-session-id"] || uuidv4();
    const greeting = await callGrok(buildSystemPrompt(text.slice(0, 2000), "teach"), [
      { role: "user", content: "Hi! I just uploaded my study material. Please greet me and give a short overview of what we'll be learning." },
    ]);

    await Session.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          sessionId,
          fileName,
          knowledgeChunks: embeddedChunks,
          mode: "teach",
          quizState: null,
          lastActiveAt: new Date(),
        },
        $push: {
          history: {
            $each: [
              { role: "user", content: "Hi! I just uploaded my study material." },
              { role: "assistant", content: greeting, audioUrl: null },
            ],
          },
        },
      },
      { upsert: true, new: true }
    );

    const cleanPreview = text.replace(/\s+/g, " ").trim().slice(0, 300);

    res.json({
      sessionId,
      message: "Raw file uploaded successfully. Your tutor is ready!",
      fileName,
      previewText: cleanPreview + (text.length > 300 ? "..." : ""),
      tutorGreeting: greeting,
    });
  } catch (err) {
    console.error("Upload/raw error:", err.message);
    res.status(500).json({ error: "Failed to process raw upload.", detail: err.message });
  }
});


app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message)
      return res.status(400).json({ error: "sessionId and message are required." });

    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found. Please upload a file first." });

    const wantsQuiz = /quiz|test me|test my knowledge/i.test(message);

    if (wantsQuiz && !session.quizState) {
      const questions = await generateQuizQuestions(session.knowledgeChunks, 5);
      session.quizState = {
        questions: questions.map((q) => ({ ...q, asked: false })),
        currentIndex: 0,
        score: 0,
        active: true,
      };
      session.mode = "quiz";
    }

    const context = await retrieveRelevant(message, session.knowledgeChunks);

    const mode = session.mode === "quiz" || (session.quizState?.active) ? "quiz" : "teach";

    const systemPrompt = buildSystemPrompt(context, mode);

    // Push user message first (for history)
    session.history.push({ role: "user", content: message });

    const tutorReply = await callGrok(systemPrompt,   trimHistory(toGrokHistory(session.history)));
    console.log("Grok reply:", tutorReply);
    let cloudinaryResult = null;

    try {
         const audioBuffer = await textToSpeech(tutorReply);
        console.log("Audio buffer generated, size:", audioBuffer.length);
        console.log("Uploading audio to Cloudinary...");
        cloudinaryResult = await uploadToCloudinary(audioBuffer);
        console.log("Cloudinary upload result:", cloudinaryResult);
    } catch (error) {
        console.log("Audio generation/upload error:", error.message);
    }

    const url = cloudinaryResult?.secure_url || null;
    console.log("Generated audio URL:", url); 
    session.history.push({ role: "assistant", content: tutorReply, audioUrl: url });
    session.lastActiveAt = new Date();
    await session.save();

    res.json({ sessionId, userMessage: message, tutorReply, url, mode, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Chat error:", err.message);
    console.log("error", err);
    res.status(500).json({ error: "Chat failed.", detail: err.message });
  }
});

/**
 * POST /quiz/start
 * Body: { sessionId, questionCount? }
 */
app.post("/quiz/start", async (req, res) => {
  try {
    const { sessionId, questionCount = 5 } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required." });

    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found." });
    console.log("sessions", session);
    const context = await retrieveRelevant("Generate quiz questions from this study material", session.knowledgeChunks);
    // console.log("context", context);
    // console.log("session knowledge chunks", session.knowledgeChunks);
    const questions = await generateQuizQuestions(context, questionCount);
    if (!questions || questions.length === 0) {
      return res.status(500).json({
      error: "Quiz generation failed. No questions returned."
    });
}
    console.log("questions", questions);
    session.quizState = {
      questions: questions.map((q) => ({ ...q, asked: false })),
      currentIndex: 0,
      score: 0,
      active: true,
      startedAt: new Date(),
    };
    session.mode = "quiz";
    console.log("questions from quiz", session.quizState.questions[0]);
    const firstQ = session.quizState.questions[0];
    
    if (!firstQ) {
      return res.status(500).json({
      error: "First question is undefined."
     });
    }

    firstQ.asked = true;

    const intro = `Quiz time! I have ${questions.length} questions for you. Let's see how well you know this material! 🎯\n\nQuestion 1 of ${questions.length}: ${firstQ.question}`;
    let cloudinaryResult = null;

    try {
         const audioBuffer = await textToSpeech(intro);

        cloudinaryResult = await uploadToCloudinary(audioBuffer);
    } catch (error) {
        console.log("Audio generation/upload error:", error.message);
    }

    const url = cloudinaryResult?.secure_url || null;

    session.history.push({ role: "assistant", content: intro, audioUrl: url });
    session.lastActiveAt = new Date();
    await session.save();
    
    res.json({ sessionId, message: "Quiz started!", firstQuestion: firstQ.question, tutorMessage: intro, url, totalQuestions: questions.length, currentQuestion: 1 });
  } catch (err) {
    console.error("Quiz start error:", err.message);
    res.status(500).json({ error: "Failed to start quiz.", detail: err.message });
  }
});

app.post("/quiz/answer", async (req, res) => {
  try {
    const { sessionId, answer } = req.body;
    if (!sessionId || !answer)
      return res.status(400).json({ error: "sessionId and answer are required." });

    const session = await Session.findOne({ sessionId });
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (!session.quizState?.active)
      return res.status(400).json({ error: "No active quiz. Use POST /quiz/start." });

    const quiz    = session.quizState;
    const current = quiz.questions[quiz.currentIndex];

    // Evaluating answers from grok and will provide score as well
    const evalPrompt = `You are a quiz evaluator.
     Question: "${current.question}"
     Correct answer: "${current.answer}"
     Student's answer: "${answer}"

     Respond ONLY with valid JSON — no markdown:
     { 
     "correct": true/false, "feedback": "1–2 sentence feedback, reveal correct answer if wrong" 
     }`;

    const evalRes = await axios.post(
      `${GROK_BASE_URL}/chat/completions`,
      { model: GROK_MODEL, messages: [{ role: "user", content: evalPrompt }], temperature: 0.3, max_tokens: 200 },
      { headers: { Authorization: `Bearer ${GROK_API_KEY}`, "Content-Type": "application/json" } }
    );

    const rawEval = evalRes.data.choices[0].message.content.trim();
    let evaluation;
    try {
      const cleaned = rawEval.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`No JSON object found in eval response: ${rawEval}`);
      evaluation = JSON.parse(match[0]);

      if (typeof evaluation.correct !== "boolean") evaluation.correct = false;
      if (typeof evaluation.feedback !== "string") evaluation.feedback = "Good attempt! Keep going.";
    } catch (parseErr) {
      console.error("Eval parse failed. Raw:", rawEval);
      evaluation = {
        correct: false,
        feedback: `The correct answer is: ${current.answer}`,
      };
    }

    // Persist answer + result on the question
    current.studentAnswer = answer;
    current.correct       = evaluation.correct;
    if (evaluation.correct) quiz.score++;
    quiz.currentIndex++;

    let replyText   = evaluation.feedback;
    let nextQuestion = null;
    let quizComplete = false;

    if (quiz.currentIndex < quiz.questions.length) {
      const next   = quiz.questions[quiz.currentIndex];
      nextQuestion = next.question;
      replyText   += `\n\nQuestion ${quiz.currentIndex + 1} of ${quiz.questions.length}: ${next.question}`;
    } else {
      quiz.active      = false;
      quiz.completedAt = new Date();
      quizComplete     = true;
      session.mode     = "teach";
      const pct   = Math.round((quiz.score / quiz.questions.length) * 100);
      const praise =
        pct === 100 ? "Perfect score! You're a superstar! 🌟" :
        pct >= 80  ? "Excellent work! You clearly know your material! 🎉" :
        pct >= 60  ? "Good effort! Review what you missed and you'll nail it next time! 💪" :
                    "Keep studying — you're making progress! Let's go over the material again. 📚";
      replyText += `\n\n🎓 Quiz complete! You scored ${quiz.score}/${quiz.questions.length} (${pct}%). ${praise}`;
    }

     let cloudinaryResult = null;

    try {
         const audioBuffer = await textToSpeech(replyText);

        cloudinaryResult = await uploadToCloudinary(audioBuffer);
    } catch (error) {
        console.log("Audio generation/upload error:", error.message);
    }

    const url = cloudinaryResult?.secure_url || null;


    session.history.push(
      { role: "user",      content: answer },
      { role: "assistant", content: replyText, audioUrl: url }
    );
    session.lastActiveAt = new Date();

    // markModified needed for nested subdoc changes in Mongoose
    session.markModified("quizState");
    await session.save();

    // let cloudinaryResult = null;

    // try {
    //      const audioBuffer = await textToSpeech(tutorReply);

    //     cloudinaryResult = await uploadToCloudinary(audioBuffer);
    // } catch (error) {
    //     console.log("Audio generation/upload error:", error.message);
    // }

    // const url = cloudinaryResult?.secure_url || null;

    res.json({
      sessionId,
      yourAnswer: answer,
      correct: evaluation.correct,
      feedback: evaluation.feedback,
      nextQuestion:   nextQuestion || undefined,
      quizComplete,
      currentScore:   quiz.score,
      totalQuestions: quiz.questions.length,
      tutorMessage:   replyText,
      audioUrl:url,
    });
  } catch (err) {
    console.error("Quiz answer error:", err.message);
    res.status(500).json({ error: "Failed to evaluate answer.", detail: err.message });
  }
});


app.get("/session/:id", async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id }).lean();
    if (!session) return res.status(404).json({ error: "Session not found." });

    res.json({
      sessionId:    session.sessionId,
      fileName:     session.fileName,
      mode:         session.mode,
      messageCount: session.history.length,
      transcript:   session.history,
      quizState: session.quizState
        ? {
            active:         session.quizState.active,
            score:          session.quizState.score,
            totalQuestions: session.quizState.questions.length,
            currentIndex:   session.quizState.currentIndex,
            completedAt:    session.quizState.completedAt,
            questions:      session.quizState.questions.map(({ question, answer, studentAnswer, correct }) => ({
              question, answer, studentAnswer, correct,
            })),
          }
        : null,
      createdAt:    session.createdAt,
      lastActiveAt: session.lastActiveAt,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch session.", detail: err.message });
  }
});

app.delete("/session/:id", async (req, res) => {
  try {
    const result = await Session.deleteOne({ sessionId: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Session not found." });
    res.json({ message: "Session deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session.", detail: err.message });
  }
});


app.get("/sessions", async (req, res) => {
  try {
    const sessions = await Session.find({}, "sessionId fileName mode lastActiveAt createdAt").lean();
    res.json({ count: sessions.length, sessions });
  } catch (err) {
    res.status(500).json({ error: "Failed to list sessions.", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => app.listen(PORT, () => console.log(`🎓 Tutor Agent running on http://localhost:${PORT}`)))
  .catch((err) => { console.error("Failed to connect to MongoDB:", err.message); process.exit(1); });