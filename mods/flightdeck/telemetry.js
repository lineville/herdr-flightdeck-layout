// Reads an agent's model and context use from the bottom of its screen, and says how each
// model looks. Herdr doesn't report either, but agents print both on their status line:
//   Claude Code: "Opus 5.5 ⚡medium │ ████░░░░ 31% 311k/1.0M │ ..."
//   Pi:          "◆ gpt-6.1-sol │ ⚡ medium │ 7d ░░░░  1% │ █████░░░ 63% 317k/..."
// No Herdr imports, so it stays pure.

// A meter, then a percentage, then a token count: "███░░ 31% 311k". The digit after the
// percentage tells context apart from usage meters such as Pi's "7d ░░░░  1% │".
const CONTEXT = /[█▓▒░■□▰▱]+\s*(\d{1,3})%\s*\d/;

const MODELS = [
  /\b(fable|opus|sonnet|haiku)(?:[\s-]*(\d+(?:[.-]\d+)?))?/i,
  /\bclaude-([\w.-]+)/i,
  /\b(gpt-[\w.-]+)/i,
  /\b(codex-[\w.-]+)/i,
  /\b(gemini-[\w.-]+)/i,
  /\b(o\d(?:-mini|-pro)?)\b/i,
];

const findModel = (line) => {
  for (const re of MODELS) {
    const m = re.exec(line);
    if (!m) continue;
    if (re === MODELS[0]) return m[2] ? `${m[1]} ${m[2].replace("-", ".")}` : m[1];
    return m[1];
  }
  return null;
};

// From `hc read` output: { ctx: 0..1, model } or null when no status line shows (a dialog
// may cover it). Only the line with the context meter is read, so a model named in the
// conversation above never counts.
export function parseStatusLine(text) {
  const lines = String(text ?? "").split("\n").slice(-16).reverse();
  for (const line of lines) {
    const m = CONTEXT.exec(line);
    if (!m) continue;
    return { ctx: Math.min(100, Number(m[1])) / 100, model: findModel(line) };
  }
  return null;
}

// How a model looks: its glyph, and a size for how capable it is (1 is the middle).
// Bigger reads as smarter; mini and nano variants shrink, pro variants grow.
export function modelLook(model, app) {
  const m = String(model ?? "").toLowerCase();
  const tierOf = (base) => (/nano/.test(m) ? 0.7 : /mini|flash|lite/.test(m) ? 0.82 : /pro|max/.test(m) ? base + 0.12 : base);
  if (m.includes("fable")) return { glyph: "crystal", size: 1.3, family: "Fable" };
  if (m.includes("opus")) return { glyph: "ringed", size: 1.2, family: "Opus" };
  if (m.includes("sonnet")) return { glyph: "moon", size: 1.0, family: "Sonnet" };
  if (m.includes("haiku")) return { glyph: "asteroid", size: 0.75, family: "Haiku" };
  if (m.startsWith("gpt") || /^o\d/.test(m)) return { glyph: "station", size: tierOf(1.1), family: "GPT" };
  if (m.startsWith("codex")) return { glyph: "sat", size: tierOf(1.05), family: "Codex" };
  if (m.startsWith("gemini")) return { glyph: "probe", size: tierOf(1.0), family: "Gemini" };
  // No model read yet: fall back on the agent program.
  const a = String(app ?? "").toLowerCase();
  if (a.includes("claude")) return { glyph: "moon", size: 1.0, family: null };
  if (a.includes("codex")) return { glyph: "sat", size: 1.0, family: null };
  return { glyph: "probe", size: 1.0, family: null };
}
