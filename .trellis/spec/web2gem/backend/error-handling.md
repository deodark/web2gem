# Error Handling

## Request Parsing

`src/http/index.ts` owns JSON request parsing through `readJsonRequest`. It reads the body as bytes, decodes with fatal UTF-8 decoding, parses JSON through `tryParseJson`, and accepts only JSON objects.

OpenAI-compatible routes convert parse failures with `openAIErrorResponse`. Google-compatible routes return `{ error: { message } }` JSON responses.

## Upstream Errors

Use `upstreamErrorMessage` and `upstreamErrorCode` from `src/shared/runtime.ts` when converting unknown errors. OpenAI upstream failures should use OpenAI-style error envelopes when possible.

Do not silently change request semantics after a failure. A request with an explicit `model` must either use that model or return `model_not_found`; do not fall back to `DEFAULT_MODEL` for empty or unknown explicit model values. A request that requires authenticated Gemini text-file attachments must either complete with those attachments or return the corresponding error; do not retry it as anonymous or without failed context files. Image input is the exception: if image upload is unavailable or partially fails, the worker may continue as text-only only when it adds a dropped-image note to the prompt and logs safe metadata. Transport-only socket-to-fetch fallback is allowed because it preserves headers, cookie, model, body, and file references.

When `GEMINI_COOKIE` is configured and Gemini generation returns an authentication-style upstream status (`401` or `403`), classify it immediately as `invalid_gemini_cookie` before reading or parsing the response body, log safe metadata, and return HTTP 401 to OpenAI-compatible and Google-compatible callers. Do not retry the same request anonymously. Image upload may still degrade as described above; text-file context upload must fail instead of falling back.

When `GEMINI_COOKIE` is configured, generation requests must also verify the Gemini page auth token (`at`) before calling `StreamGenerate`. If `/app` does not yield `at`, return `invalid_gemini_cookie` immediately instead of sending the generation request without `at`, because that silently turns the request into anonymous behavior.

Streaming paths should keep partial-output behavior intact:

- SSE producers use `sseResponse`.
- `sseResponse` must abort the producer `AbortSignal` when the client cancels or when `controller.enqueue(...)` fails, so provider streams stop pulling upstream data promptly.
- Stream warnings use `writeStreamWarningEvent` or protocol-specific error helpers.
- Client disconnects and aborts should not be converted into noisy stream errors.

## Scenario: SSE Producer Abort Semantics

### 1. Scope / Trigger

Use this contract when changing `src/http/core/sse.ts`, protocol stream writers, or provider stream loops that consume the `AbortSignal` passed by `sseResponse`.

### 2. Signatures

- `sseResponse(producer, options)` passes `producer(write, signal)`.
- `write(chunk)` accepts an already-framed SSE string.
- `signal` is aborted on client `cancel()` and on enqueue failure.

### 3. Contracts

- Stream producers must pass the signal into provider streaming calls when possible.
- `write()` failure means the response stream is no longer writable; abort the signal and suppress further writes.
- Abort errors from provider streams should be rethrown or swallowed as disconnects, not converted into protocol error events.

### 4. Validation & Error Matrix

- Client cancels SSE body -> producer signal is aborted; no stream-error event is emitted.
- `controller.enqueue` throws -> producer signal is aborted; no further chunks are enqueued.
- Provider throws non-abort before output -> protocol adapter may emit an error event.
- Provider throws non-abort after partial output -> protocol adapter preserves partial output and may emit a warning.

### 5. Good/Base/Bad Cases

- Good: `write()` catches enqueue failure, marks the stream closed, and calls `AbortController.abort(...)`.
- Base: `cancel()` aborts the same controller used by producer code.
- Bad: enqueue failure only sets a local `closed` boolean while the upstream provider stream continues running.

### 6. Tests Required

- Unit test that canceling an SSE body aborts the signal observed by the producer.
- Unit or targeted helper test for enqueue-failure abort behavior when the controller can no longer accept chunks.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing stream wiring.

### 7. Wrong vs Correct

#### Wrong

```typescript
try { controller.enqueue(bytes); } catch (_) { closed = true; }
```

#### Correct

```typescript
try {
  controller.enqueue(bytes);
} catch (_) {
  closed = true;
  abortController.abort("stream closed");
}
```

## Top-Level Worker Errors

`src/index.ts` catches unhandled route errors, logs through `log(cfg, ...)`, and returns a JSON 500 response. Keep this as the final fallback, not the primary validation mechanism.

## Scenario: Oversized Inline Long Context

### 1. Scope / Trigger

Use this contract when a request may be too large to send inline to Gemini Web and context-file attachments are unavailable. This prevents Worker CPU from being spent on JSON parsing, prompt conversion, Gemini `f.req` serialization, or URL form encoding for a request that cannot be handled safely.

### 2. Signatures

- HTTP boundary: JSON route helpers may reject POST routes before `readJsonRequest` when `Content-Length` exceeds the attachment-aware body read limit for inline-context-unavailable requests.
- JSON boundary: `readJsonRequest(request, { maxBodyBytes, oversizedError })` may stop reading `request.body` as soon as streamed bytes exceed the configured limit.
- Completion boundary: `preparePromptWithAttachments` may return `ContextFileFailure` with `ErrorWithMetadata`.
- Error code: `large_context_inline_unsupported`.

### 3. Contracts

- Environment keys:
  - `CURRENT_INPUT_FILE_ENABLED=true` keeps context-file attachment support enabled.
  - `CURRENT_INPUT_FILE_MIN_BYTES` is the oversized threshold.
  - `GENERIC_FILE_UPLOAD_MAX_BYTES` contributes to the JSON body read limit because base64 request-local attachments increase `Content-Length` without increasing inline prompt bytes.
  - `GEMINI_COOKIE` must be configured for text attachment upload.
  - `LOG_REQUESTS` is opt-in and should not be required for normal operation.
- `Content-Length` is not an inline prompt size. It includes base64 image/file bytes that prompt conversion later replaces with markers and attachment candidates.
- If `Content-Length` is present and exceeds the attachment-aware body read limit while context-file attachments are unavailable, return 413 before parsing JSON. The client-facing message should include `<contentLength> bytes > <bodyLimit>` and the inline prompt threshold.
- If `Content-Length` is absent or inaccurate and streamed body bytes exceed the attachment-aware body read limit while context-file attachments are unavailable, `readJsonRequest` returns 413 before decoding/parsing the full body. The client-facing message should include `at least <bodyLimit + 1> UTF-8 bytes > <bodyLimit>` and the inline prompt threshold.
- If a parsed prompt exceeds the threshold after prompt conversion has removed request-local attachment payloads from the live prompt, return 413 before provider generation when context-file attachments are unavailable. The client-facing message should include `<promptBytes> UTF-8 bytes > <threshold>`; bounded checks may say `at least <bytes>`.
- If conversion-time checks show the base prompt or estimated final inline prompt exceeds the threshold while text attachments are available, choose the context-file path before constructing the full hidden-tools/structured inline prompt string.
- In the context-file path, upload `CURRENT_TOOLS_FILE_NAME` (default `tools.txt`) as the home for tool-use context. It must contain visible tool descriptions/schemas when present, DSML tool-call format instructions, the tool-choice policy text when present, and `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT`. The live prompt should only reference the attached tools file and must not duplicate DSML call-format instructions or the hidden native tool payload text.
- If no client-visible tools are declared, still attach `tools.txt` for the hidden native tool prompt when the request uses context files. Token accounting for context-file prompts must include history text, `tools.txt`, and the short live prompt exactly once.
- OpenAI-compatible routes return an OpenAI error envelope.
- Google-compatible routes return `{ error: { message, code } }`.

### 4. Validation & Error Matrix

- `Content-Length > attachment-aware body read limit` and no `GEMINI_COOKIE` -> 413 `large_context_inline_unsupported`.
- Streamed request body exceeds attachment-aware body read limit and no `GEMINI_COOKIE` -> 413 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and no `GEMINI_COOKIE` -> 413 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and `CURRENT_INPUT_FILE_ENABLED=false` -> 413 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and text upload fails -> 502 `large_context_file_upload_failed`.
- Context-file path with visible tools -> upload `message.txt` and `tools.txt`; provider prompt references `tools.txt` but does not contain `Available tools`, `<|DSML|tool_calls>`, or `Gemini native hidden tool calls`.
- Context-file path without visible tools -> upload `message.txt` and `tools.txt`; `tools.txt` contains `Gemini native hidden tool calls`.
- Prompt bytes are within threshold -> continue existing inline prompt flow.

### 5. Good/Base/Bad Cases

- Good: reject an oversized no-cookie request before `readJsonRequest` when `Content-Length` proves it exceeds the attachment-aware body read limit.
- Good: pass the attachment-aware body read limit into `readJsonRequest` when inline text attachments are unavailable, so oversized invalid JSON is still bounded while valid image/file requests can reach prompt conversion.
- Good: use conversion-time prompt byte checks plus a bounded final-inline estimate to select context-file upload before concatenating a large hidden-tools/structured inline prompt.
- Good: put tool schemas, DSML call instructions, tool-choice policy, and hidden native tool instructions into `tools.txt` for context-file requests.
- Base: use context-file upload for large authenticated requests and send only the short live prompt inline.
- Bad: allow a multi-megabyte no-cookie prompt to reach Gemini `buildPayload`, which serializes the full prompt into nested JSON and URL form encoding.
- Bad: prepend `toolCallInstructionsFor(...)`, `toolChoiceInstruction`, or `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT` to the live prompt after `tools.txt` has been attached.

### 6. Tests Required

- Unit test that oversized invalid JSON with `Content-Length` returns 413 when the body read limit is exceeded, proving the HTTP guard runs before parsing.
- Unit test that oversized invalid JSON without `Content-Length` returns 413 from bounded stream reading when the body read limit is exceeded, proving the body reader stops before JSON parsing.
- Unit test that a request with inline image data and small text prompt can exceed `CURRENT_INPUT_FILE_MIN_BYTES` as `Content-Length` and still reach JSON parsing / prompt conversion.
- Unit test that parsed oversized prompts without attachment support return `large_context_inline_unsupported`.
- Unit test that context-file requests with visible tools put `Available tool descriptions`, `<|DSML|tool_calls>`, tool-choice policy, and hidden native tool text in `tools.txt`, while the provider live prompt only references the file.
- Unit test that context-file requests without visible tools still upload `tools.txt` containing the hidden native tool prompt.
- Unit test or smoke coverage that existing small-prompt and context-file helper behavior still works.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const parsed = await readJsonRequest(request);
// Later: buildPayload(largePrompt, ...)
```

#### Correct

```typescript
const rejection = oversizedInlineBodyRejection(request, cfg);
if (rejection) return openAIErrorResponse(rejection.message, 413, rejection.code);
const parsed = await readJsonRequest(request);
```

#### Wrong

```typescript
const livePrompt = [
  toolCallInstructionsFor(toolSource, toolDefs),
  choiceInstruction,
  currentInputFilePrompt(cfg, true),
  GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT,
].join("\n\n");
```

#### Correct

```typescript
const toolsText = toolsContextTranscriptFor(toolSource, choiceInstruction, cfg.current_tools_file_name, toolDefs);
const livePrompt = currentInputFilePrompt(cfg, true);
```
