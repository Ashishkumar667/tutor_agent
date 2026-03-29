const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    audioUrl: { type: String, default: null },
    transcribedFrom: { type: String, default: null }, 
  },
  { _id: false, timestamps: true }
);

const QuizQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
    asked: { type: Boolean, default: false },
    studentAnswer: { type: String, default: null },
    correct: { type: Boolean, default: null },
  },
  { _id: false }
);

const QuizStateSchema = new mongoose.Schema(
  {
    questions: [QuizQuestionSchema],
    currentIndex: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const SessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    fileName: { type: String, required: true },
    knowledgeChunks: [
      {
        text: String,
        embedding: [Number]
      }
    ],
    history: [MessageSchema],
    quizState: { type: QuizStateSchema, default: null },
    mode: { type: String, enum: ["teach", "quiz"], default: "teach" },
    lastActiveAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true, // createdAt, updatedAt
    // TTL index: auto-delete sessions inactive for 7 days (production safety)
    // Remove this if you want permanent sessions
  }
);

// Auto-update lastActiveAt on every save
SessionSchema.pre("save", function (next) {
  this.lastActiveAt = new Date();
  next();
});

// TTL index — sessions expire after 7 days of inactivity
SessionSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

module.exports = mongoose.model("Session", SessionSchema);