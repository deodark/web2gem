import { tryParseJson } from "../shared/json";
import { isRecord } from "../shared/types";
import { normalizeParsedToolCallsForSchemas, parseDSMLToolCallsDetailed } from "./parse";

type GoogleParsedToolCall = { name?: unknown; input?: unknown };
export type GoogleFunctionCall = { name: unknown; args: unknown };

const LEGACY_FUNCTION_CALL_PATTERNS = [
  /```function_call\s*\n([\s\S]*?)\n```/g,
  /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g,
] as const;

function normalizeGoogleParsedCalls(calls: GoogleParsedToolCall[], toolsRaw: unknown): GoogleParsedToolCall[] {
  const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
  return Array.isArray(normalized) ? normalized as GoogleParsedToolCall[] : calls;
}

function toGoogleFunctionCalls(calls: GoogleParsedToolCall[]): GoogleFunctionCall[] {
  return calls.map((call) => ({ name: call.name, args: call.input || {} }));
}

function googleFunctionCallFromRecord(data: unknown): GoogleFunctionCall | null {
  if (!isRecord(data) || !("name" in data)) return null;
  const args = data.args != null
    ? data.args
    : data.arguments != null
      ? data.arguments
      : data.input != null
        ? data.input
        : {};
  return { name: data.name, args };
}

/** Extract DSML/XML or legacy ```function_call``` blocks -> [cleanText, functionCalls]. */
export function parseGoogleFunctionCalls(text: unknown, toolsRaw: unknown): [string, GoogleFunctionCall[]] {
  const parsed = parseDSMLToolCallsDetailed(text);
  if (parsed.calls.length) {
    const normalized = normalizeGoogleParsedCalls(parsed.calls, toolsRaw);
    return [parsed.cleanText, toGoogleFunctionCalls(normalized)];
  }
  if (!parsed.sawToolCallSyntax && !mayContainGoogleFunctionCallSyntax(text)) return [String(text || ""), []];

  const functionCalls: GoogleFunctionCall[] = [];
  let clean = String(text || "");
  for (const pat of LEGACY_FUNCTION_CALL_PATTERNS) {
    pat.lastIndex = 0;
    clean = clean.replace(pat, (full: string, body: string) => {
      const parsedJson = tryParseJson(String(body || "").trim());
      if (!parsedJson.ok) return full;
      const call = googleFunctionCallFromRecord(parsedJson.value);
      if (!call) return full;
      functionCalls.push(call);
      return "";
    }).trim();
    pat.lastIndex = 0;
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    const parsedJson = tryParseJson(clean.trim());
    if (parsedJson.ok) {
      const data = parsedJson.value;
      if (isRecord(data) && "name" in data && ("args" in data || "arguments" in data || "input" in data)) {
        const call = googleFunctionCallFromRecord(data);
        if (call) functionCalls.push(call);
        clean = "";
      }
    }
  }
  const normalized = normalizeGoogleParsedCalls(functionCalls.map((fc) => ({ name: fc.name, input: fc.args || {} })), toolsRaw);
  return [clean, toGoogleFunctionCalls(normalized)];
}

function mayContainGoogleFunctionCallSyntax(text: unknown): boolean {
  const source = String(text || "");
  if (source.indexOf("function_call") >= 0) return true;
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return source.indexOf("\"name\"") >= 0 && (
    source.indexOf("\"args\"") >= 0 ||
    source.indexOf("\"arguments\"") >= 0 ||
    source.indexOf("\"input\"") >= 0
  );
}
