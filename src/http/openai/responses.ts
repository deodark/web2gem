import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG, runCompletionText, upstreamEmptyWarning } from "../../completion";
import type { CompletionProvider } from "../../completion";
import { prepareOpenAICompletion } from "../../completion/openai";
import { normalizeResponsesInputAsMessagesStrict } from "../../promptcompat/responses-input";
import { elapsedMs, errorLogSummary, log, logStage, nowMs, nowSec, randHex, upstreamErrorCode, upstreamErrorMessage } from "../../shared/runtime";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import { buildResponsesOutput, finalizeOpenAICompletionResult, openAIResponsesUsage } from "./format";
import { streamResponsesWithToolSieve, writeResponsesEvent } from "./responses-stream";
import type { RuntimeConfig } from "../../config";

  // POST /v1/responses(Codex CLI 用)
export async function handleResponses(req: Record<string, unknown> | undefined, cfg: RuntimeConfig, provider: CompletionProvider) {
  if (!req) return openAIErrorResponse("request body must be a JSON object", 400);
  const normalized = normalizeResponsesInputAsMessagesStrict(req);
  if (normalized.error) return openAIErrorResponse(normalized.error, 400, "unsupported_responses_input");
  const messages = normalized.messages;

  const logRequests = !!cfg.log_requests;
  const prepareStart = logRequests ? nowMs() : 0;
  const prepared = await prepareOpenAICompletion(cfg, provider, req, messages, req.tools, { emptyPromptMessage: "empty input" });
  if ("error" in prepared) {
    if (logRequests) logStage(cfg, "openai_responses_prepare", { ms: elapsedMs(prepareStart), status: prepared.error.status, code: prepared.error.code });
    return openAIErrorResponse(prepared.error.message, prepared.error.status, prepared.error.code);
  }
  const { rm, structured, allTools, toolPolicy, tools: filteredTools, promptToolChoice, prompt, fileRefs, promptTokens, contextFiles } = prepared;
  if (logRequests) {
    logStage(cfg, "openai_responses_prepare", {
      ms: elapsedMs(prepareStart),
      status: 200,
      model: rm.name,
      promptChars: prompt.length,
      promptTokens,
      fileRefs: fileRefs ? fileRefs.length : 0,
      contextFiles: !!contextFiles,
      contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
      rawTools: allTools.length,
      filteredTools: Array.isArray(filteredTools) ? filteredTools.length : 0,
    });
  }
  const tools = filteredTools;

  if (req.stream && structured) {
    return openAIErrorResponse("response_format with stream is not supported by this worker because final JSON cannot be validated while streaming", 400, "unsupported_response_format_stream");
  }

  if (req.stream) {
    const rid = `resp_${randHex(16)}`;
    const streamTools = tools && promptToolChoice !== "none" ? tools : (promptToolChoice === "none" ? allTools : null);
    return sseResponse(async (write, signal) => {
      const generationStart = logRequests ? nowMs() : 0;
      await streamResponsesWithToolSieve(write, cfg, {
        provider,
        rid,
        rm,
        prompt,
        fileRefs,
        tools: streamTools,
        toolPolicy,
        promptTokens,
        signal,
      });
      if (logRequests) logStage(cfg, "openai_responses_stream_generate", { ms: elapsedMs(generationStart), model: rm.name, promptTokens, fileRefs: fileRefs ? fileRefs.length : 0, tools: Array.isArray(streamTools) ? streamTools.length : 0 });
    }, {
      onError: (write, e) => writeResponsesEvent(write, "response.failed", {
        response: { id: rid, object: "response", status: "failed", model: rm.name, output: [], error: { message: upstreamErrorMessage(e), code: upstreamErrorCode(e) || "stream_error" } },
      }),
    });
  }

  let text: string;
  const generationStart = logRequests ? nowMs() : 0;
  try {
    text = await runCompletionText(provider, { prompt, rm, fileRefs });
  } catch (e) {
    if (logRequests) logStage(cfg, "openai_responses_generate", { ms: elapsedMs(generationStart), status: "error", model: rm.name });
    log(cfg, `openai responses generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`);
    return openAIUpstreamErrorResponse(e);
  }
  if (logRequests) logStage(cfg, "openai_responses_generate", { ms: elapsedMs(generationStart), status: "ok", model: rm.name, completionChars: text.length, promptTokens, fileRefs: fileRefs ? fileRefs.length : 0 });

  const finalized = finalizeOpenAICompletionResult(text, { tools, noneModeTools: allTools, promptToolChoice, structured, toolPolicy });
  if (finalized.error) return openAIErrorResponse(finalized.error.message, finalized.error.status, finalized.error.code);
  let { toolCalls, upstreamEmpty } = finalized;
  text = finalized.text;

  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  if (!text && !toolCalls) {
    upstreamEmpty = true;
    log(cfg, `openai responses generate produced no content model=${rm.name}`);
    text = EMPTY_UPSTREAM_MSG;
  }
  const output = buildResponsesOutput(text, toolCalls, mid);

  const usage = openAIResponsesUsage(promptTokens, text);

  const payload: Record<string, unknown> = { id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, output, usage };
  if (upstreamEmpty) payload.warning = upstreamEmptyWarning(cfg);
  return jsonResponse(payload);
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
