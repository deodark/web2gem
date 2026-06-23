import { trimContinuationOverlap } from "../../shared/tokens";

const STREAM_APPEND_PROBE_CHARS = 64;

type WrbLineParseIssue =
  | "ok"
  | "not_wrb_line"
  | "invalid_envelope_json"
  | "invalid_envelope_shape"
  | "missing_inner_payload"
  | "invalid_inner_json"
  | "invalid_inner_shape"
  | "missing_text_parts"
  | "empty_text_parts";

type WrbLineParseResult = {
  texts: string[];
  issue: WrbLineParseIssue;
  parsedEnvelope: boolean;
  parsedInner: boolean;
};

export function stripArtifacts(text: unknown): string {
  let source = String(text || "");
  if (!source) return "";
  if (source.indexOf("```") >= 0 && source.indexOf("code_event_index=") >= 0) {
    source = source.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g, "");
  }
  if (source.indexOf("googleusercontent.com/card_content") >= 0 && source.indexOf("http://googleusercontent.com/card_content/") >= 0) {
    source = source.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  }
  return source;
}

function hasArtifactMarkers(source: string): boolean {
  return (
    source.indexOf("```") >= 0
    && source.indexOf("code_event_index=") >= 0
  ) || (
    source.indexOf("googleusercontent.com/card_content") >= 0
    && source.indexOf("http://googleusercontent.com/card_content/") >= 0
  );
}

export function cleanText(text: unknown): string {
  return stripArtifacts(text).trim();
}

export function extractTextsFromLine(line: unknown): string[] {
  return parseWrbLine(line).texts;
}

export function wrbResponseShapeSummary(raw: unknown): string {
  const source = String(raw || "");
  let lines = 0;
  let wrbLines = 0;
  let parsedEnvelopes = 0;
  let parsedInners = 0;
  let textParts = 0;
  const issues: Record<string, number> = {};
  for (const line of iterateLines(source)) {
    if (!line) continue;
    lines += 1;
    const parsed = parseWrbLine(line);
    if (parsed.issue === "not_wrb_line") continue;
    wrbLines += 1;
    if (parsed.parsedEnvelope) parsedEnvelopes += 1;
    if (parsed.parsedInner) parsedInners += 1;
    textParts += parsed.texts.length;
    if (parsed.issue !== "ok") issues[parsed.issue] = (issues[parsed.issue] || 0) + 1;
  }
  const topIssue = Object.entries(issues).sort((a, b) => b[1] - a[1])[0];
  return [
    `lines=${lines}`,
    `wrbLines=${wrbLines}`,
    `parsedEnvelopes=${parsedEnvelopes}`,
    `parsedInnerPayloads=${parsedInners}`,
    `textParts=${textParts}`,
    topIssue ? `topIssue=${topIssue[0]}:${topIssue[1]}` : "",
  ].filter(Boolean).join(" ");
}

function parseWrbLine(line: unknown): WrbLineParseResult {
  const source = String(line || "");
  if (!isWrbResponseLineCandidate(source)) return wrbLineIssue("not_wrb_line");
  let arr: unknown;
  try {
    arr = JSON.parse(source);
  } catch (_) {
    return wrbLineIssue("invalid_envelope_json");
  }
  if (!Array.isArray(arr) || !Array.isArray(arr[0])) return wrbLineIssue("invalid_envelope_shape");
  const innerStr = arr[0][2];
  if (typeof innerStr !== "string") return wrbLineIssue("missing_inner_payload", true);
  let inner: unknown;
  try {
    inner = JSON.parse(innerStr);
  } catch (_) {
    return wrbLineIssue("invalid_inner_json", true);
  }
  if (!(Array.isArray(inner) && inner.length > 4)) return wrbLineIssue("invalid_inner_shape", true, true);
  const textGroups = inner[4];
  if (!Array.isArray(textGroups)) return wrbLineIssue("missing_text_parts", true, true);
  const texts: string[] = [];
  for (const part of textGroups) {
    if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
      for (const t of part[1]) {
        if (typeof t === "string" && t) texts.push(t);
      }
    }
  }
  return {
    texts,
    issue: texts.length ? "ok" : "empty_text_parts",
    parsedEnvelope: true,
    parsedInner: true,
  };
}

function wrbLineIssue(issue: WrbLineParseIssue, parsedEnvelope = false, parsedInner = false): WrbLineParseResult {
  return { texts: [], issue, parsedEnvelope, parsedInner };
}

function isWrbResponseLineCandidate(source: string): boolean {
  let i = skipJsonWhitespace(source, 0);
  if (source.charCodeAt(i) !== 91) return false; // [
  i = skipJsonWhitespace(source, i + 1);
  if (source.charCodeAt(i) !== 91) return false; // [
  i = skipJsonWhitespace(source, i + 1);
  return source.startsWith('"wrb.fr"', i);
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length) {
    const c = source.charCodeAt(index);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    index += 1;
  }
  return index;
}

export function extractResponseText(raw: unknown): string {
  let lastText = "";
  const source = String(raw || "");
  for (const line of iterateLines(source)) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

function* iterateLines(source: string): Generator<string> {
  let start = 0;
  while (start <= source.length) {
    const idx = source.indexOf("\n", start);
    if (idx < 0) {
      yield source.slice(start);
      return;
    }
    yield source.slice(start, idx);
    start = idx + 1;
  }
}

export function createStreamTextExtractor() {
  let prevVisible = "";
  let prevVisibleHead = "";
  let prevVisibleTail = "";
  let prevRaw = "";
  let prevRawHead = "";
  let prevRawTail = "";
  let prevRawHasArtifacts = false;
  let started = false;
  const rememberRaw = (raw: string) => {
    prevRaw = raw;
    prevRawHead = raw.slice(0, STREAM_APPEND_PROBE_CHARS);
    prevRawTail = raw.slice(-STREAM_APPEND_PROBE_CHARS);
    prevRawHasArtifacts = hasArtifactMarkers(raw);
  };
  const rememberVisible = (visible: string) => {
    prevVisible = visible;
    prevVisibleHead = visible.slice(0, STREAM_APPEND_PROBE_CHARS);
    prevVisibleTail = visible.slice(-STREAM_APPEND_PROBE_CHARS);
  };
  const appendVisibleDelta = (delta: string) => {
    rememberVisible(prevVisible + delta);
  };
  const rawAppendDelta = (raw: string): string | null => {
    if (!prevRaw || raw.length <= prevRaw.length || prevRawHasArtifacts) return null;
    if (prevRaw.length <= STREAM_APPEND_PROBE_CHARS * 2) {
      if (!raw.startsWith(prevRaw)) return null;
    } else if (
      raw.slice(0, prevRawHead.length) !== prevRawHead
      || raw.slice(prevRaw.length - prevRawTail.length, prevRaw.length) !== prevRawTail
    ) {
      return null;
    }
    const delta = raw.slice(prevRaw.length);
    if (hasArtifactMarkers(prevRawTail + delta)) return null;
    return delta;
  };
  const visibleAppendDelta = (visible: string): string | null => {
    if (!prevVisible || visible.length <= prevVisible.length) return null;
    if (prevVisible.length <= STREAM_APPEND_PROBE_CHARS * 2) {
      if (!visible.startsWith(prevVisible)) return null;
    } else if (
      visible.slice(0, prevVisibleHead.length) !== prevVisibleHead
      || visible.slice(prevVisible.length - prevVisibleTail.length, prevVisible.length) !== prevVisibleTail
    ) {
      return null;
    }
    return visible.slice(prevVisible.length);
  };
  const consumeLine = function* (line: unknown): Generator<string> {
    for (const t of extractTextsFromLine(line)) {
      const raw = String(t || "");
      let delta = "";
      const appendedRawDelta = rawAppendDelta(raw);
      if (appendedRawDelta !== null) {
        delta = appendedRawDelta;
        appendVisibleDelta(delta);
        rememberRaw(raw);
      } else {
        const visible = stripArtifacts(raw);
        if (!prevVisible) {
          delta = visible;
          rememberVisible(visible);
          rememberRaw(raw);
        } else {
          const appendedVisibleDelta = visibleAppendDelta(visible);
          if (appendedVisibleDelta !== null) {
            delta = appendedVisibleDelta;
            rememberVisible(visible);
            rememberRaw(raw);
          } else if (prevVisible.startsWith(visible)) {
            continue;
          } else {
            delta = trimContinuationOverlap(prevVisible, visible);
            if (!delta) {
              if (visible.length > prevVisible.length) {
                rememberVisible(visible);
                rememberRaw(raw);
              }
              continue;
            }
            appendVisibleDelta(delta);
            rememberRaw(raw);
          }
        }
      }
      if (!started) delta = delta.replace(/^\s+/, "");
      if (delta) {
        started = true;
        yield delta;
      }
    }
  };
  return { consumeLine };
}
