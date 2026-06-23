import assert from "./assertions.js";
import { mod, withConsoleLog, withFetch, withPatchedGlobal } from "./helpers.js";

export const suiteName = "uploads";
export const cases = [
  ["returns empty attachment resolution without fetching tokens", async () => {
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), []);
      assert.equal(result.fileRefs, null);
      assert.equal(result.droppedNote, "");
      assert.equal(result.usage.uploadedFiles, 0);
    });
  }],
  ["reports missing base64 decoder when no native or atob decoder exists", async () => {
    const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true, writable: true });
    try {
      await withPatchedGlobal("atob", undefined, async () => {
        await assert.rejects(() => mod.base64ToBytes("AAAA"), /base64 decoder is not available/);
      });
    } finally {
      if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
      else delete Uint8Array.fromBase64;
    }
  }],
  ["uploads direct images through preferred multipart without content-push auth", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const requests = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      requests.push({ href, init });
      if (href === "https://gemini.example/app") {
        return new Response('{"qKIAYe":"push-direct"}', { status: 200 });
      }
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "image.jpg", mime: "image/jpeg" });
        return new Response("/uploaded/direct-image-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadImage(baseUploadCfg({
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
      }), new Uint8Array([1, 2]), "image/jpeg");
      assert.equal(ref, "/uploaded/direct-image-ref");
    });
    assert.deepEqual(requests.map((request) => request.href), [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload",
    ]);
  }],
  ["does not cache page-token fetch failures as successful empty token results", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let appCalls = 0;
    await withFetch(async (url) => {
      const href = String(url);
      if (href === "https://gemini.example/app") {
        appCalls += 1;
        throw new Error("app unavailable");
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      assert.deepEqual(await mod.getPageTokens(baseUploadCfg()), {});
      assert.deepEqual(await mod.getPageTokens(baseUploadCfg()), {});
    });
    assert.equal(appCalls, 2);
  }],
  ["logs default content-push token fallback when app page markers are missing", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response("no token markers", { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assert.equal(init.headers["Push-ID"], "feeds/mcudyrk2a4khkz");
        return new Response("/uploaded/default-token-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadTextFile(baseUploadCfg({ cookie: "__Secure-1PSID=psid", log_requests: true }), "hello", "message.txt");
      assert.deepEqual(ref, { ref: "/uploaded/default-token-ref", name: "message.txt" });
    }));
    assert.equal(logs.some((line) => line.includes("app page token markers missing")), true);
    assert.equal(logs.some((line) => line.includes("content-push upload using default page token") && line.includes("fields=push_id")), true);
  }],
  ["degrades anonymous images instead of passing file refs to generation", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages(baseUploadCfg(), [{ b64: "aGVsbG8=", mime: "image/png", filename: "../unsafe name.png" }]);
      assert.equal(result.fileRefs, null);
      assert.equal(result.imageFileRefs, null);
      assert.equal(result.supportsFileRefs, false);
      assert.match(result.droppedNote, /image input requires a configured GEMINI_COOKIE/);
      assert.equal(result.usage.uploadedFiles, 0);
    });
  }],
  ["inlines anonymous text files instead of uploading unusable file refs", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), [
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
      ]);
      assert.equal(result.fileRefs, null);
      assert.equal(result.supportsFileRefs, false);
      assert.match(result.promptText, /\[File attachment: same\.txt\]\nhello\n\[\/File attachment\]/);
      assert.equal((result.promptText.match(/\[File attachment/g) || []).length, 1);
      assert.equal(result.usage.uploadedFiles, 0);
      assert.equal(result.usage.inlinedFiles, 1);
      assert.equal(result.usage.dedupedFiles, 1);
    });
  }],
  ["deduplicates identical cookie-backed request-local attachments while preserving references", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    let uploadCalls = 0;
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-dedupe"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        uploadCalls += 1;
        assertPreferredMultipart(init, { filename: "same.txt", mime: "text/plain", bodyText: "hello" });
        return new Response("/uploaded/same", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({ cookie: "__Secure-1PSID=psid" }), [
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
      ]);
      assert.deepEqual(result.fileRefs, [
        { ref: "/uploaded/same", name: "same.txt" },
        { ref: "/uploaded/same", name: "same.txt" },
      ]);
      assert.equal(result.supportsFileRefs, true);
      assert.equal(result.usage.uploadedFiles, 1);
      assert.equal(result.usage.dedupedFiles, 1);
    });
    assert.equal(uploadCalls, 1);
  }],
  ["falls back to isolated resumable upload when multipart is rejected by protocol", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seen = [];
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      seen.push({ href, init });
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-fallback","Ylro7b":"pctx-fallback"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assert.equal(init.headers.Cookie, undefined);
        assert.equal(init.headers.Authorization, undefined);
        return new Response("unsupported media type", { status: 415 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; SAPISID=sapi");
        assert.match(init.headers.Authorization, /^SAPISIDHASH /);
        assert.equal(init.headers["X-Goog-Upload-Header-Content-Type"], "text/plain; charset=utf-8");
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/finalize" } });
      }
      if (href === "https://upload.example/finalize") {
        assert.equal(init.headers["X-Goog-Upload-Command"], "upload, finalize");
        assert.equal(new TextDecoder().decode(init.body), "fallback text");
        return new Response("/uploaded/fallback-text", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadTextFile(baseUploadCfg({
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
      }), "fallback text", "message.txt");
      assert.deepEqual(ref, { ref: "/uploaded/fallback-text", name: "message.txt" });
    });
    assert.deepEqual(seen.map((item) => item.href), [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload",
      "https://content-push.googleapis.com/upload/",
      "https://upload.example/finalize",
    ]);
  }],
  ["does not send auth fallback after multipart returns an invalid file ref", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const seen = [];
    await withFetch(async (url) => {
      const href = String(url);
      seen.push(href);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-invalid-ref"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") return new Response("not-a-content-push-ref", { status: 200 });
      throw new Error(`unexpected fallback fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
      }), [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /attachment upload failed/);
    });
    assert.deepEqual(seen, [
      "https://gemini.example/app",
      "https://content-push.googleapis.com/upload",
    ]);
  }],
  ["does not fetch or upload remote image URLs", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveImages(baseUploadCfg(), [{ url: "https://images.example/path/remote%20image.webp?size=large" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /invalid image input/);
      assert.equal(result.usage.uploadedFiles, 0);
    });
  }],
  ["uploads generic code files through preferred multipart when generation can consume file refs", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-file"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "main.py", mime: "text/x-python", bodyText: "print(1)\n" });
        return new Response("/uploaded/code-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({ cookie: "__Secure-1PSID=psid" }), [{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "../main.py" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/code-ref", name: "main.py" }]);
      assert.deepEqual(result.genericFileRefs, [{ ref: "/uploaded/code-ref", name: "main.py" }]);
      assert.equal(result.droppedNote, "");
    });
  }],
  ["sniffs upload MIME from bytes when metadata is absent", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-sniff"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "file-1.pdf", mime: "application/pdf", bodyText: "%PDF-1.4\n" });
        return new Response("/uploaded/pdf-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({ cookie: "__Secure-1PSID=psid" }), [{ b64: "JVBERi0xLjQK" }]);
      assert.deepEqual(result.fileRefs, [{ ref: "/uploaded/pdf-ref", name: "file-1.pdf" }]);
    });
  }],
  ["does not fetch or upload remote generic file URLs", async () => {
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), [{ type: "input_file", file_url: "https://files.example/src/main.ts?download=1", filename: "main.ts" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /missing generic file upload data/);
      assert.equal(result.usage.uploadedFiles, 0);
    });
  }],
  ["inlines empty anonymous generic text files", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), [{ type: "input_file", file_data: "", mime: "text/plain", filename: "empty.txt" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.promptText, /\[File attachment: empty\.txt\]\n\n\[\/File attachment\]/);
      assert.equal(result.usage.inlinedFiles, 1);
      assert.equal(result.usage.inlinedBytes, 0);
    });
  }],
  ["does not fetch Google fileData fileUri as a generic upload URL", async () => {
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), [{ type: "file", fileData: { fileUri: "https://files.example/main.py", mimeType: "text/x-python", displayName: "main.py" } }]);
      assert.equal(result.fileRefs, null);
      assert.equal(result.droppedNote, "");
    });
  }],
  ["degrades invalid base64 and oversized inline files with deterministic notes", async () => {
    const invalid = await mod.resolveFiles(baseUploadCfg(), [{ b64: "not base64!?", mime: "text/plain" }]);
    assert.equal(invalid.fileRefs, null);
    assert.match(invalid.droppedNote, /1 file\(s\).*invalid base64 payload/);

    const tooLarge = await mod.resolveFiles(baseUploadCfg({ generic_file_upload_max_bytes: 2 }), [{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" }]);
    assert.equal(tooLarge.fileRefs, null);
    assert.match(tooLarge.droppedNote, /1 file\(s\).*file attachment is too large/);
  }],
  ["rejects oversized inline generic base64 before invoking runtime decoders", async () => {
    const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    Object.defineProperty(Uint8Array, "fromBase64", {
      value() {
        throw new Error("fromBase64 should not be called for oversized input");
      },
      configurable: true,
      writable: true,
    });
    try {
      await withPatchedGlobal("atob", () => {
        throw new Error("atob should not be called for oversized input");
      }, async () => {
        const result = await mod.resolveFiles(baseUploadCfg({ generic_file_upload_max_bytes: 2 }), [{ b64: "AAAA", mime: "application/octet-stream" }]);
        assert.equal(result.fileRefs, null);
        assert.match(result.droppedNote, /file attachment is too large/);
      });
    } finally {
      if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
      else delete Uint8Array.fromBase64;
    }
  }],
  ["remote file URLs are rejected before any network read", async () => {
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({ generic_file_upload_max_bytes: 2 }), [{ type: "input_file", file_url: "https://files.example/large.bin", filename: "large.bin" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /missing generic file upload data/);
    });
  }],
  ["degrades anonymous binary files that cannot be safely inlined", async () => {
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg(), [{ b64: "AA==" }]);
      assert.equal(result.fileRefs, null);
      assert.match(result.droppedNote, /file attachment requires a configured GEMINI_COOKIE/);
    });
  }],
  ["uploads text context files through preferred multipart", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    await withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-text"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "message.txt", mime: "text/plain; charset=utf-8", bodyText: "hello" });
        return new Response("/uploaded/text-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const ref = await mod.uploadTextFile(baseUploadCfg({ cookie: "__Secure-1PSID=psid; SAPISID=sapi", sapisid: "sapi" }), "hello", "message.txt");
      assert.deepEqual(ref, { ref: "/uploaded/text-ref", name: "message.txt" });
    });
  }],
  ["records max-file overflow as a degradable planning note", async () => {
    const files = Array.from({ length: 51 }, (_, index) => ({ b64: "AA==", mime: "text/plain", filename: `f${index}.txt` }));
    const plan = mod.createAttachmentPlan({ files });
    assert.equal(plan.candidates.length, 50);
    assert.equal(plan.dropped.length, 1);
    assert.match(mod.droppedAttachmentNote(plan.dropped), /exceeded maximum of 50 attachments per request/);
  }],
  ["classifies OpenAI request attachments without upload transport", async () => {
    const plan = mod.collectOpenAIRequestAttachmentPlan({
      ref_file_ids: ["file-top"],
      messages: [{
        role: "user",
        content: [{ type: "input_file", data: "ZG9udA==", filename: "content-direct.txt", mime_type: "text/plain" }],
        attachments: [{ type: "input_file", file_data: "bXNn", filename: "message-attach.txt", mime_type: "text/plain" }],
      }],
      attachments: [
        { type: "input_file", id: "inline-id", file_data: "aGVsbG8=", filename: "note.txt", mime: "text/plain" },
        { type: "input_file", file_id: "file-existing", filename: "existing.txt" },
        { type: "input_file", file: { id: "nested-inline-id", data: "AA==", filename: "nested.txt", mime: "application/octet-stream" } },
        { type: "input_file", filename: "missing.txt" },
        { content: [{ type: "input_file", file_data: "d3JhcA==", filename: "wrapped.txt", mime_type: "text/plain" }] },
        { type: "text", text: "ignored" },
      ],
    });
    assert.deepEqual(plan.existingFileRefs, [
      "file-top",
      { id: "file-existing", name: "existing.txt" },
    ]);
    assert.equal(plan.candidates.length, 4);
    assert.deepEqual(plan.candidates.map((candidate) => ({
      kind: candidate.kind,
      filename: candidate.filename,
      mime: candidate.mime,
      sourceType: candidate.source.type,
    })), [
      { kind: "file", filename: "note.txt", mime: "text/plain", sourceType: "base64" },
      { kind: "file", filename: "nested.txt", mime: "application/octet-stream", sourceType: "base64" },
      { kind: "file", filename: "wrapped.txt", mime: "text/plain", sourceType: "base64" },
      { kind: "file", filename: "message-attach.txt", mime: "text/plain", sourceType: "base64" },
    ]);
    assert.deepEqual(plan.dropped.map((drop) => ({
      kind: drop.kind,
      code: drop.code,
      filename: drop.filename,
    })), [
      { kind: "file", code: "invalid_file_input", filename: "missing.txt" },
    ]);
  }],
  ["classifies OpenAI request-level image blocks without upload transport", async () => {
    const plan = mod.collectOpenAIRequestAttachmentPlan({
      attachments: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" }, filename: "../outer.png" },
        { type: "image_url", url: "data:image/gif;base64,R0lGODlh", filename: "direct.gif" },
      ],
      files: [
        { type: "input_image", image_url: "data:;base64,BBBB", mime_type: "image/jpeg", filename: "inline.jpg" },
      ],
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,SHOULD_NOT_DUPLICATE==" } }],
      }],
    });
    assert.equal(plan.candidates.length, 3);
    assert.deepEqual(plan.candidates.map((candidate) => ({
      kind: candidate.kind,
      filename: candidate.filename,
      mime: candidate.mime,
      sourceType: candidate.source.type,
      data: candidate.source.data,
    })), [
      { kind: "image", filename: "outer.png", mime: "image/png", sourceType: "base64", data: "QUJDRA==" },
      { kind: "image", filename: "direct.gif", mime: "image/gif", sourceType: "base64", data: "R0lGODlh" },
      { kind: "image", filename: "inline.jpg", mime: "image/jpeg", sourceType: "base64", data: "BBBB" },
    ]);
    assert.deepEqual(mod.collectOpenAIInlineUploadImages({
      attachments: [{ type: "image_url", image_url: { url: "data:image/webp;base64,V0VCUA==" }, filename: "outer.webp" }],
    }), [
      { b64: "V0VCUA==", mime: "image/webp", filename: "outer.webp" },
    ]);
  }],
  ["logs structured attachment upload usage when request logging is enabled", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-log"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "same.txt", mime: "text/plain", bodyText: "hello" });
        return new Response("/uploaded/log-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({ cookie: "__Secure-1PSID=psid", log_requests: true }), [
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
        { b64: "aGVsbG8=", mime: "text/plain", filename: "same.txt" },
      ]);
      assert.equal(result.usage.uploadedFiles, 1);
      assert.equal(result.usage.dedupedFiles, 1);
      assert.equal(result.usage.multipartUploads, 1);
      assert.equal(result.usage.resumableFallbacks, 0);
    }));
    const stageLog = logs.find((line) => line.includes("stage=attachment_upload")) || "";
    assert.match(stageLog, /candidates=2/);
    assert.match(stageLog, /uploadedFiles=1/);
    assert.match(stageLog, /dedupedFiles=1/);
    assert.match(stageLog, /uploadedBytes=5/);
    assert.match(stageLog, /multipartUploads=1/);
    assert.match(stageLog, /resumableFallbacks=0/);
  }],
  ["logs resumable fallback counts for request-local attachments", async () => {
    mod.resetActiveGeminiCookieForTest();
    mod.resetGeminiUploadCachesForTest();
    const logs = [];
    await withConsoleLog((line) => logs.push(String(line)), () => withFetch(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://gemini.example/app") return new Response('{"qKIAYe":"push-log-fallback","Ylro7b":"pctx-log-fallback"}', { status: 200 });
      if (href === "https://content-push.googleapis.com/upload") {
        assertPreferredMultipart(init, { filename: "fallback.txt", mime: "text/plain", bodyText: "hello" });
        return new Response("unsupported media type", { status: 415 });
      }
      if (href === "https://content-push.googleapis.com/upload/") {
        assert.equal(init.headers.Cookie, "__Secure-1PSID=psid; SAPISID=sapi");
        assert.match(init.headers.Authorization, /^SAPISIDHASH /);
        return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/log-fallback-finalize" } });
      }
      if (href === "https://upload.example/log-fallback-finalize") {
        return new Response("/uploaded/log-fallback-ref", { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    }, async () => {
      const result = await mod.resolveFiles(baseUploadCfg({
        cookie: "__Secure-1PSID=psid; SAPISID=sapi",
        sapisid: "sapi",
        log_requests: true,
      }), [{ b64: "aGVsbG8=", mime: "text/plain", filename: "fallback.txt" }]);
      assert.equal(result.usage.uploadedFiles, 1);
      assert.equal(result.usage.multipartUploads, 0);
      assert.equal(result.usage.resumableFallbacks, 1);
    }));
    const stageLog = logs.find((line) => line.includes("stage=attachment_upload")) || "";
    assert.match(stageLog, /multipartUploads=0/);
    assert.match(stageLog, /resumableFallbacks=1/);
  }],
];

function baseUploadCfg(overrides = {}) {
  return {
    gemini_origin: "https://gemini.example",
    cookie: "",
    sapisid: "",
    request_timeout_sec: 180,
    upstream_socket: false,
    log_requests: false,
    generic_file_upload_max_bytes: 1024,
    ...overrides,
  };
}

function assertPreferredMultipart(init, expected) {
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Tenant-Id"], "bard-storage");
  assert.equal(init.headers.Cookie, undefined);
  assert.equal(init.headers.Authorization, undefined);
  assert.match(init.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  const text = new TextDecoder().decode(init.body);
  assert.match(text, new RegExp(`name="file"; filename="${escapeRegExp(expected.filename)}"`));
  assert.match(text, new RegExp(`Content-Type: ${escapeRegExp(expected.mime)}`));
  if (expected.bodyText !== undefined) assert.match(text, new RegExp(escapeRegExp(expected.bodyText)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
