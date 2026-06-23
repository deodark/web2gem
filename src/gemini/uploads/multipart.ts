import type { RuntimeConfig } from "../../config";
import { joinByteChunks } from "../../attachments/materialize";
import { sanitizeUploadFilename } from "../../attachments/media";
import { TEXT_ENCODER } from "../../shared/runtime";
import { httpFetch } from "../transport";
import { contentPushUploadError, validateContentPushFileRef } from "./errors";
import { contentPushUploadTokens, GEMINI_UPLOAD_USER_AGENT, getPageTokensForConfig, logContentPushTokenFallback } from "./tokens";

export type UploadBytesInput = {
  bytes: Uint8Array;
  mime: string;
  filename: string;
};

const MULTIPART_UPLOAD_ENDPOINT = "https://content-push.googleapis.com/upload";

export async function uploadMultipartFile(cfg: RuntimeConfig, input: UploadBytesInput): Promise<string> {
  const pageTokens = await getPageTokensForConfig(cfg);
  const tokens = contentPushUploadTokens(pageTokens);
  logContentPushTokenFallback(cfg, "multipart", tokens, ["push_id"]);
  const multipart = buildMultipartFileBody(input);
  const headers: Record<string, string> = {
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/",
    "X-Tenant-Id": "bard-storage",
    "Push-ID": tokens.pushId,
    "User-Agent": GEMINI_UPLOAD_USER_AGENT,
    "Content-Type": multipart.contentType,
  };
  const response = await httpFetch(MULTIPART_UPLOAD_ENDPOINT, {
    method: "POST",
    headers,
    body: multipart.body,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
    cfg,
  });
  if (!response.ok) {
    throw contentPushUploadError("content_push_http_status", `multipart upload failed with HTTP ${response.status}`, {
      status: response.status,
      protocol: "multipart",
    });
  }
  return validateContentPushFileRef(await response.text(), "multipart");
}

export function buildMultipartFileBody(input: UploadBytesInput): { body: Uint8Array; contentType: string; boundary: string } {
  const boundary = `----web2gem-${randomBoundarySuffix()}`;
  const filename = escapeMultipartFilename(input.filename || "upload.bin");
  const mime = String(input.mime || "application/octet-stream").replace(/[\r\n]/g, "").trim() || "application/octet-stream";
  const head = TEXT_ENCODER.encode([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mime}`,
    "",
    "",
  ].join("\r\n"));
  const tail = TEXT_ENCODER.encode(`\r\n--${boundary}--\r\n`);
  return {
    body: joinByteChunks([head, input.bytes, tail], head.byteLength + input.bytes.byteLength + tail.byteLength),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary,
  };
}

function escapeMultipartFilename(filename: string): string {
  const safe = sanitizeUploadFilename(filename) || "upload.bin";
  return safe.replace(/\\/g, "_").replace(/"/g, "_");
}

function randomBoundarySuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
