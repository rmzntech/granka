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
