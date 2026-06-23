import type { RuntimeConfig } from "../../config";
import { chooseUploadMime } from "../../attachments/media";
import { makeSapisidHash } from "../../shared/runtime";
import { configWithFreshGeminiCookie, rotateGeminiCookieForRetry } from "../cookies";
import { httpFetch } from "../transport";
import { validateContentPushFileRef } from "./errors";
import { contentPushUploadTokens, GEMINI_UPLOAD_USER_AGENT, getPageTokensForConfig, logContentPushTokenFallback } from "./tokens";
import type { UploadBytesInput } from "./multipart";

const RESUMABLE_UPLOAD_ENDPOINT = "https://content-push.googleapis.com/upload/";

export async function uploadResumableFile(cfg: RuntimeConfig, input: UploadBytesInput): Promise<string> {
  const activeCfg = await configWithFreshGeminiCookie(cfg);
  return uploadResumableFileWithConfig(activeCfg, input, false);
}

async function uploadResumableFileWithConfig(cfg: RuntimeConfig, input: UploadBytesInput, retriedAfterRotate: boolean): Promise<string> {
  const pageTokens = await getPageTokensForConfig(cfg);
  const tokens = contentPushUploadTokens(pageTokens);
  logContentPushTokenFallback(cfg, "resumable", tokens);
  const contentType = chooseUploadMime(input.mime);

  const startHeaders: Record<string, string> = {
    "Push-ID": tokens.pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": tokens.pctx,
    "X-Goog-Upload-Header-Content-Length": String(input.bytes.length),
    "X-Goog-Upload-Header-Content-Type": contentType,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": GEMINI_UPLOAD_USER_AGENT,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);

  const start = await httpFetch(RESUMABLE_UPLOAD_ENDPOINT, {
    method: "POST",
    headers: startHeaders,
    body: "",
    timeoutMs: 30000,
    socket: cfg.upstream_socket,
    cfg,
  });
  if (isAuthFailureStatus(start.status) && !retriedAfterRotate) {
    const rotatedCfg = await rotateGeminiCookieForRetry(cfg);
    if (rotatedCfg) return uploadResumableFileWithConfig(rotatedCfg, input, true);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${start.status})`);

  const finish = await httpFetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Type": "application/octet-stream",
      "User-Agent": GEMINI_UPLOAD_USER_AGENT,
    },
    body: input.bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
    cfg,
  });
  return validateContentPushFileRef(await finish.text(), "resumable");
}

function isAuthFailureStatus(status: unknown): boolean {
  return Number(status) === 401 || Number(status) === 403;
}
