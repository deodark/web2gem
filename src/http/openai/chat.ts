import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG, runCompletionText, upstreamEmptyWarning } from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import { prepareOpenAICompletion } from "../../completion/openai";
import { elapsedMs, errorLogSummary, log, logStage, nowMs, nowSec, randHex, upstreamErrorCode } from "../../shared/runtime";
import { tokenEst } from "../../shared/tokens";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import { finalizeOpenAICompletionResult } from "./format";
import { writeOpenAIChatStreamError } from "./format";
import { streamOpenAIChatPlain, streamOpenAIChatWithToolSieve } from "./chat-stream";

// POST /v1/chat/completions
export async function handleChat(req: UnknownRecord, cfg: RuntimeConfig, provider: CompletionProvider) {
  const messages = req.messages || [];
  const logRequests = !!cfg.log_requests;
  const prepareStart = logRequests ? nowMs() : 0;
  const prepared = await prepareOpenAICompletion(cfg, provider, req, messages, req.tools, { emptyPromptMessage: "empty prompt" });
  if ("error" in prepared) {
    if (logRequests) logStage(cfg, "openai_chat_prepare", { ms: elapsedMs(prepareStart), status: prepared.error.status, code: prepared.error.code });
    return openAIErrorResponse(prepared.error.message, prepared.error.status, prepared.error.code);
  }
  const { rm, structured, allTools, tools, toolPolicy, promptToolChoice, prompt, fileRefs, promptTokens, contextFiles } = prepared;
  if (logRequests) {
    logStage(cfg, "openai_chat_prepare", {
      ms: elapsedMs(prepareStart),
      status: 200,
      model: rm.name,
      promptChars: prompt.length,
      promptTokens,
      fileRefs: fileRefs ? fileRefs.length : 0,
      contextFiles: !!contextFiles,
      contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
    });
  }

  const stream = !!req.stream;
  if (stream && structured) {
    return openAIErrorResponse("response_format with stream is not supported by this worker because final JSON cannot be validated while streaming", 400, "unsupported_response_format_stream");
  }
  const cid = `chatcmpl-${randHex(12)}`;
  const streamOptions = isRecord(req.stream_options) ? req.stream_options : null;
  const includeStreamUsage = !!(streamOptions && streamOptions.include_usage);
  const detectForbiddenToolCalls = !!(stream && promptToolChoice === "none" && allTools.length);

  if (stream && (!tools || promptToolChoice === "none") && !detectForbiddenToolCalls) {
    return sseResponse(async (write, signal) => {
      const generationStart = logRequests ? nowMs() : 0;
      await streamOpenAIChatPlain(write, cfg, {
        provider,
        id: cid,
        model: rm.name,
        prompt,
        rm,
        fileRefs,
        includeUsage: includeStreamUsage,
        promptTokens,
        signal,
      });
      if (logRequests) logStage(cfg, "openai_chat_stream_generate", { ms: elapsedMs(generationStart), model: rm.name, promptTokens, fileRefs: fileRefs ? fileRefs.length : 0 });
    }, { onError: (write, e) => writeOpenAIChatStreamError(write, cid, rm.name, e) });
  }

  if (stream && ((tools && promptToolChoice !== "none") || detectForbiddenToolCalls)) {
    return sseResponse(async (write, signal) => {
      const generationStart = logRequests ? nowMs() : 0;
      await streamOpenAIChatWithToolSieve(write, cfg, {
        provider,
        id: cid,
        model: rm.name,
        prompt,
        rm,
        fileRefs,
        tools: tools || allTools,
        toolPolicy,
        includeUsage: includeStreamUsage,
        promptTokens,
        signal,
      });
      if (logRequests) logStage(cfg, "openai_chat_stream_generate", { ms: elapsedMs(generationStart), model: rm.name, promptTokens, fileRefs: fileRefs ? fileRefs.length : 0, tools: (tools || allTools).length });
    }, { onError: (write, e) => writeOpenAIChatStreamError(write, cid, rm.name, e) });
  }

  let text: string;
  const generationStart = logRequests ? nowMs() : 0;
  try {
    text = await runCompletionText(provider, { prompt, rm, fileRefs });
  } catch (e) {
    if (logRequests) logStage(cfg, "openai_chat_generate", { ms: elapsedMs(generationStart), status: "error", model: rm.name });
    log(cfg, `openai chat generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`);
    return openAIUpstreamErrorResponse(e);
  }
  if (logRequests) logStage(cfg, "openai_chat_generate", { ms: elapsedMs(generationStart), status: "ok", model: rm.name, completionChars: text.length, promptTokens, fileRefs: fileRefs ? fileRefs.length : 0 });

  const finalized = finalizeOpenAICompletionResult(text, { tools, noneModeTools: allTools, promptToolChoice, structured, toolPolicy });
  if (finalized.error) return openAIErrorResponse(finalized.error.message, finalized.error.status, finalized.error.code);
  let { toolCalls, upstreamEmpty } = finalized;
  text = finalized.text;
  if (!text && !toolCalls) {
    upstreamEmpty = true;
    log(cfg, `openai chat generate produced no content model=${rm.name}`);
    text = EMPTY_UPSTREAM_MSG; // 可见提示,避免客户端“无返回”
  }
  const msg: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  const finish = toolCalls ? "tool_calls" : "stop";

  const payload: Record<string, unknown> = {
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: (() => {
      const completionTokens = tokenEst(text);
      return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    })(),
  };
  if (upstreamEmpty) payload.warning = upstreamEmptyWarning(cfg);
  return jsonResponse(payload);
}
