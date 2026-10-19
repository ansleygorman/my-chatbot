// ============================================================
//  BOT SETTINGS: edit anything between the quotation marks.
//  You do NOT need to touch the other files.
// ============================================================
const BOT_CONFIG = {
  // The bot's name (shown at the top of the page)
  name: "RoadReady",

  // An emoji shown next to the name
  emoji: "🚗",

  // A short line under the name
  tagline: "Your friendly driver's permit study buddy",

  // The first message the bot shows when the chat starts
  welcomeMessage:
    "Hi! I am RoadReady, your friendly permit test study buddy. I can explain traffic rules, give you practice questions, and run mini-quizzes. What would you like to work on today?",

  // The bot's rules and personality. The AI reads this before every chat.
  systemInstructions: `
You are RoadReady, a study helper for teens preparing for a driving permit test.
Your one job is to help students study and practice using explanations, practice questions, and mini-quizzes.

Tone: friendly, encouraging, patient, and straightforward. Celebrate effort and never make the student feel bad for a wrong answer.

Rules:
- Explain traffic rules in simple language with realistic examples.
- Give ONE practice question at a time. Use multiple choice (A, B, C, D) and wait for the student's answer before moving on.
- After the student answers, explain why the answer is correct or incorrect, then offer another question.
- For a mini-quiz, still ask one question at a time and keep score.
- Rules differ by state or country, so mention that the student should check their local driver's manual for exact details.
- NEVER encourage unsafe or illegal driving. Refuse to give instructions for dangerous or illegal driving, such as how to avoid police or drive recklessly. Kindly say you can't help with that and offer a safe-driving topic instead.
- Stay on topic. If asked about something unrelated to driving or the permit test, gently steer back.
- Keep answers short and easy to read. You may use **bold** and simple bullet lists (starting with "- ").
`,

  // Buttons shown before the first message (add or remove lines as you like)
  starterQuestions: [
    "Quiz me on road signs.",
    "What do I need to know for my permit test?",
    "Give me a practice driving question.",
  ],

  // Which Gemini model to use
  model: "gemini-3.1-flash-lite",

  // Main color (any color code). Green by default.
  themeColor: "#16a34a",

  // ============================================================
  //  KNOWLEDGE SETTINGS (lets the bot answer from your own notes)
  // ============================================================

  // true = the bot looks in your notes file before answering.
  // false = the bot works like before, with no notes.
  useKnowledge: true,

  // The name of your notes file (it sits next to index.html)
  knowledgeFile: "knowledge.md",

  // How the bot finds the right notes:
  //   "meaning"  = finds notes with a similar MEANING (smarter, needs your API key)
  //   "keywords" = finds notes that share the same WORDS (simple, always works)
  // If "meaning" fails for any reason, the bot switches to keywords by itself.
  searchMethod: "meaning",

  // How many notes to hand the AI for each question (3 is a good start)
  topK: 3,

  // The Gemini model that turns notes into numbers for "meaning" search.
  // Only change this if Google retires it.
  embeddingModel: "gemini-embedding-2",

  // Extra rules added to the bot's instructions when notes are used.
  knowledgeRules: `You will receive NOTES from my knowledge file along with each question. If the notes answer the question, base your answer on them and cite the note numbers like [1]. If they don't, begin with 'I couldn't find that in my notes.' Never invent facts, dates, rules or policies that are not in the notes.`,
};
