// Pure helpers extracted from agent.mjs (no SDK, no state) — safe to test
// with plain node and to import without circular dependencies.
export const MODEL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const acceptsText = (model) =>
  (model.type ?? "chat") === "chat" && Array.isArray(model.input) && model.input.includes("text");

export function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Some providers stream reasoning as ordinary answer text, so a turn ends up
// with its own thinking glued to the front of the reply. Strip an exact
// reasoning prefix instead of storing the same words twice.
export function stripThinkingEcho(text, thinking) {
  const answer = String(text ?? "");
  const source = String(thinking ?? "").trim();
  if (source.length < 80) return answer;
  const head = source.slice(0, Math.min(source.length, 200));
  const trimmed = answer.trimStart();
  if (!trimmed.startsWith(head)) return answer;
  return trimmed.slice(source.length).trimStart();
}

export function usageOf(message) {
  const usage = message?.usage;
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite ?? 0,
    total: usage.totalTokens,
    cost: usage.cost?.total ?? 0,
    billed: Boolean(usage.cost?.totalFromProvider),
  };
}
