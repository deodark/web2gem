import { extractGeminiAppPageTokens, type GeminiAppPageTokens } from "../app-page";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import type { RuntimeConfig } from "../../config";
import { configWithFreshGeminiCookie } from "../cookies";
import { errorLogSummary, log } from "../../shared/runtime";

type PageTokens = GeminiAppPageTokens;
type PageTokenCache = { key: string; tokens: PageTokens | null; ts: number };
type PageTokenPending = { key: string; promise: Promise<PageTokens> | null };
export type ContentPushUploadTokens = {
  pushId: string;
  pctx: string;
  usedDefaultPushId: boolean;
  usedDefaultPctx: boolean;
};

export const GEMINI_UPLOAD_USER_AGENT = GEMINI_WEB_USER_AGENT;
export const DEFAULT_CONTENT_PUSH_PUSH_ID = "feeds/mcudyrk2a4khkz";
export const DEFAULT_CONTENT_PUSH_PCTX = "CgcSBWjK7pYx";
export let _pageTokens: PageTokenCache = { key: "", tokens: null, ts: 0 };
export let _pageTokensPending: PageTokenPending = { key: "", promise: null };

const PAGE_TOKEN_CACHE_TTL_MS = 600000;
const EMPTY_PAGE_TOKEN_CACHE_TTL_MS = 30000;

export function resetGeminiUploadCachesForTest(): void {
  _pageTokens = { key: "", tokens: null, ts: 0 };
  _pageTokensPending = { key: "", promise: null };
}

export async function getPageTokens(cfg: RuntimeConfig): Promise<PageTokens> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  return getPageTokensForConfig(activeCfg);
}

export async function getPageTokensForConfig(activeCfg: RuntimeConfig): Promise<PageTokens> {
  const now = Date.now();
  const cacheKey = `${activeCfg.gemini_origin || "https://gemini.google.com"}\x00${activeCfg.cookie || ""}`;
  if (_pageTokens.tokens && _pageTokens.key === cacheKey && now - _pageTokens.ts < pageTokenCacheTtl(_pageTokens.tokens)) return _pageTokens.tokens;
  if (_pageTokensPending.promise && _pageTokensPending.key === cacheKey) return _pageTokensPending.promise;
  const promise = (async () => {
    const headers: Record<string, string> = {
      "User-Agent": GEMINI_UPLOAD_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (activeCfg.cookie) headers["Cookie"] = activeCfg.cookie;
    const tokens: PageTokens = {};
    let shouldCache = true;
    try {
      const resp = await httpFetch(`${activeCfg.gemini_origin || "https://gemini.google.com"}/app`, {
        headers,
        timeoutMs: 30000,
        socket: activeCfg.upstream_socket,
        cfg: activeCfg,
      });
      Object.assign(tokens, await extractGeminiAppPageTokens(resp));
      if (!hasAnyPageToken(tokens)) {
        log(activeCfg, "gemini app page token markers missing; content-push upload defaults may be used");
      }
    } catch (e) {
      shouldCache = false;
      log(activeCfg, `gemini app page token fetch failed; content-push upload defaults may be used ${errorLogSummary(e)}`);
    }
    if (shouldCache) _pageTokens = { key: cacheKey, tokens, ts: now };
    return tokens;
  })();
  _pageTokensPending = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (_pageTokensPending.promise === promise) _pageTokensPending = { key: "", promise: null };
  }
}

export function contentPushUploadTokens(tokens: PageTokens | null | undefined): ContentPushUploadTokens {
  const pushId = tokens && tokens.push_id ? tokens.push_id : DEFAULT_CONTENT_PUSH_PUSH_ID;
  const pctx = tokens && tokens.pctx ? tokens.pctx : DEFAULT_CONTENT_PUSH_PCTX;
  return {
    pushId,
    pctx,
    usedDefaultPushId: pushId === DEFAULT_CONTENT_PUSH_PUSH_ID && (!tokens || tokens.push_id !== DEFAULT_CONTENT_PUSH_PUSH_ID),
    usedDefaultPctx: pctx === DEFAULT_CONTENT_PUSH_PCTX && (!tokens || tokens.pctx !== DEFAULT_CONTENT_PUSH_PCTX),
  };
}

export function logContentPushTokenFallback(cfg: RuntimeConfig, protocol: string, tokens: ContentPushUploadTokens, fieldsToReport: ReadonlyArray<"push_id" | "pctx"> = ["push_id", "pctx"]): void {
  const fields = [];
  if (fieldsToReport.includes("push_id") && tokens.usedDefaultPushId) fields.push("push_id");
  if (fieldsToReport.includes("pctx") && tokens.usedDefaultPctx) fields.push("pctx");
  if (fields.length) log(cfg, `content-push upload using default page token protocol=${protocol} fields=${fields.join(",")}`);
}

function pageTokenCacheTtl(tokens: PageTokens): number {
  return hasAnyPageToken(tokens) ? PAGE_TOKEN_CACHE_TTL_MS : EMPTY_PAGE_TOKEN_CACHE_TTL_MS;
}

function hasAnyPageToken(tokens: PageTokens): boolean {
  return !!(tokens.at || tokens.push_id || tokens.pctx);
}
