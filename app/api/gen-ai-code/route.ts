import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import type { Message, FileData } from "@/types/workspace";
import { aj } from "@/lib/arcjet";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

async function getGeminiImagePart(imageUrl: string, signal: AbortSignal) {
  const configuredStorageUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configuredStorageUrl) throw new Error("Image storage is not configured.");

  let storageOrigin: string;
  let image: URL;
  try {
    storageOrigin = new URL(configuredStorageUrl).origin;
    image = new URL(imageUrl);
  } catch {
    throw new Error("The attached image URL is invalid.");
  }

  if (
    image.origin !== storageOrigin ||
    !image.pathname.startsWith("/storage/v1/object/public/workspace-images/")
  ) {
    throw new Error("The attached image URL is not from Forge image storage.");
  }

  const response = await fetch(image, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok || !response.body) {
    throw new Error("Could not read the attached image.");
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0].trim();
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    await response.body.cancel();
    throw new Error("The attached image has an unsupported format.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Attached images must be 10 MB or smaller.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } };
}

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: unknown): string {
  return `data: ${JSON.stringify({ type, ...(payload as object) })}\n\n`;
}

function readStreamedProgressLabels(jsonText: string): string[] {
  const property = /"progress"\s*:\s*\[/g.exec(jsonText);
  if (!property) return [];

  let cursor = property.index + property[0].length;
  const labels: string[] = [];
  while (cursor < jsonText.length) {
    while (/\s|,/.test(jsonText[cursor] ?? "")) cursor++;
    if (jsonText[cursor] !== '"') break;

    const start = cursor++;
    let closed = false;
    while (cursor < jsonText.length) {
      if (jsonText[cursor] === "\\") {
        cursor += 2;
      } else if (jsonText[cursor] === '"') {
        cursor++;
        closed = true;
        break;
      } else {
        cursor++;
      }
    }
    if (!closed) break;

    try {
      const label: unknown = JSON.parse(jsonText.slice(start, cursor));
      if (typeof label === "string") labels.push(label);
    } catch {
      break;
    }
  }

  return labels;
}

// ─── npm validation ───────────────────────────────────────────────────────────

async function validateDependencies(
  deps: Record<string, string>
): Promise<Record<string, string>> {
  const valid: Record<string, string> = {};
  await Promise.all(
    Object.entries(deps).map(async ([pkg, version]) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) valid[pkg] = version;
      } catch {
        // silently skip hallucinated packages
      }
    })
  );
  return valid;
}

// ─── History trimming ─────────────────────────────────────────────────────────

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= 10) return messages;
  return [messages[0], ...messages.slice(-8)];
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert React developer. Your job is to generate complete, working React applications based on user prompts.

RULES:
1. Always respond with a valid JSON object — no markdown fences, no extra text.
2. The JSON must match this exact shape, keeping "progress" as the first property:
{
  "progress": ["2-3 word heading", "2-3 word heading", "2-3 word heading"],
  "assistantMessage": "<brief explanation of what you built/changed>",
  "title": "<short 2-4 word title for the app, e.g. 'Todo List App'>",
  "files": {
    "/App.js": { "code": "<full file content>" },
    "/components/SomeComponent.js": { "code": "<full file content>" }
  },
  "dependencies": {
    "some-package": "latest"
  }
}
3. "progress" must contain exactly three concise, user-facing task headings tailored to the request. Use action phrases, 2-3 words each, with no first-person wording or explanations. These are a brief work outline, not claims that the work is already complete.
4. Use React (functional components + hooks). Do NOT use TypeScript in generated files.
5. Use Tailwind CSS for all styling. Do not use CSS modules or inline styles unless absolutely necessary.
6. The entry point must always be /App.js and must export a default component.
7. All imports must reference files you include in "files" or packages in "dependencies".
8. Do not include react, react-dom, or tailwindcss in "dependencies" — they are always available.
9. When modifying existing code, include ALL files (both changed and unchanged) in "files".
10. Keep code clean, readable, and production-quality.
11. If the user attaches an image, use it as a design reference and match the layout/style as closely as possible.`;

// ─── Gemini contents builder ──────────────────────────────────────────────────

async function buildContents(
  messages: Message[],
  fileData: FileData | null,
  signal: AbortSignal
) {
  const trimmed = trimHistory(messages);
  const latestImageIndex = trimmed.reduce(
    (latest, message, index) => (message.imageUrl ? index : latest),
    -1
  );
  const contents = [];

  for (const [idx, msg] of trimmed.entries()) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: object[] = [];
    let text = msg.content;

    if (msg.role === "user" && msg.imageUrl && idx === latestImageIndex) {
      parts.push(await getGeminiImagePart(msg.imageUrl, signal));
      text = `[The user attached a visual reference. Use it to guide the design. If the generated app should display the same image, use this URL as its source: ${msg.imageUrl}]\n\n${text}`;
    }

    const isLast = idx === trimmed.length - 1;
    if (msg.role === "user" && isLast && fileData) {
      text +=
        "\n\nCurrent project files for context:\n" +
        JSON.stringify(fileData, null, 2);
    }

    parts.push({ text });
    contents.push({ role, parts });
  }

  return contents;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid request body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ message: "Invalid request body." }, { status: 400 });
  }

  const requestBody = body as Record<string, unknown>;
  const { workspaceId, userId, messages, fileData } = requestBody;
  const validMessages =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        ((message as Message).role === "user" ||
          (message as Message).role === "assistant") &&
        typeof (message as Message).content === "string" &&
        ((message as Message).imageUrl === undefined ||
          typeof (message as Message).imageUrl === "string")
    );
  if (
    typeof userId !== "string" ||
    !userId ||
    (workspaceId !== null && typeof workspaceId !== "string") ||
    !validMessages ||
    (fileData !== null &&
      (typeof fileData !== "object" || Array.isArray(fileData)))
  ) {
    return Response.json({ message: "Invalid request data." }, { status: 400 });
  }
  const typedMessages = messages as Message[];
  const typedFileData = fileData as FileData | null;

  // ── Arcjet: per-user rate limit + prompt-injection screening ──────────────
  // request.json() consumed the original body, so rebuild it for Arcjet's
  // request inspection. The verified Clerk ID scopes the rate limit.
  const arcjetRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });

  const lastUserMessage =
    [...typedMessages].reverse().find((message) => message.role === "user")
      ?.content ?? "";

  const decision = await aj.protect(arcjetRequest, {
    requested: 1,
    userId: clerkId,
    detectPromptInjectionMessage: lastUserMessage,
    sensitiveInfoValue: lastUserMessage,
  });

  if (decision.isDenied()) {
    if (decision.reason.isRateLimit()) {
      return Response.json(
        { message: "Too many requests. Please wait and try again." },
        { status: 429 }
      );
    }

    if (decision.reason.isPromptInjection()) {
      return Response.json(
        { message: "Prompt injection detected. Please rephrase your prompt." },
        { status: 400 }
      );
    }

    if (decision.reason.isSensitiveInfo()) {
      return Response.json(
        {
          message:
            "Sensitive information detected. Remove personal or payment details from your prompt.",
        },
        { status: 400 }
      );
    }

    return Response.json({ message: "Request blocked." }, { status: 403 });
  }

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true, plan: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  if (workspaceId) {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, userId: user.id },
      select: { id: true },
    });
    if (!workspace) {
      return Response.json({ message: "Workspace not found" }, { status: 404 });
    }
  }

  const canUseImages = user.plan === "starter" || user.plan === "pro";
  const latestMessage = typedMessages[typedMessages.length - 1];
  const latestMessageHasImage =
    typeof latestMessage?.imageUrl === "string" && latestMessage.imageUrl.length > 0;
  if (latestMessageHasImage && !canUseImages) {
    return Response.json(
      { message: "Image uploads are available on Starter and Pro plans." },
      { status: 403 }
    );
  }
  // A downgraded user may have images in saved chat history. Keep those
  // messages in storage, but don't send their image URLs back to the model.
  const messagesForModel: Message[] = canUseImages
    ? typedMessages
    : typedMessages.map((message) => {
        const textOnlyMessage = { ...message };
        delete textOnlyMessage.imageUrl;
        return textOnlyMessage;
      });

  // Reserve a credit atomically before starting the expensive generation.
  // Concurrent requests cannot both spend the same last credit.
  const reservation = await db.user.updateMany({
    where: {
      id: user.id,
      credits: { gte: CREDIT_COST_PER_GENERATION },
    },
    data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
  });

  if (reservation.count === 0) {
    return Response.json({ message: "Insufficient credits" }, { status: 402 });
  }

  const latestUserMessage = [...typedMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage) {
    await db.user.update({
      where: { id: user.id },
      data: { credits: { increment: CREDIT_COST_PER_GENERATION } },
    });
    return Response.json({ message: "A user prompt is required." }, { status: 400 });
  }

  // Persist the pending conversation first. This gives the client a stable
  // workspace URL before generation, so refreshes can recover or retry it.
  let activeWorkspaceId = workspaceId as string | null;
  try {
    if (activeWorkspaceId) {
      await db.workspace.update({
        where: { id: activeWorkspaceId, userId: user.id },
        data: { messages: typedMessages as never },
      });
    } else {
      const pendingWorkspace = await db.workspace.create({
        data: {
          userId: user.id,
          title:
            typedFileData?.title ?? latestUserMessage.content.slice(0, 80),
          messages: typedMessages as never,
          fileData: typedFileData as never,
        },
        select: { id: true },
      });
      activeWorkspaceId = pendingWorkspace.id;
    }
  } catch (error) {
    console.error("[gen-ai-code] pending workspace save error:", error);
    try {
      await db.user.update({
        where: { id: user.id },
        data: { credits: { increment: CREDIT_COST_PER_GENERATION } },
      });
    } catch (refundError) {
      console.error("[gen-ai-code] credit refund error:", refundError);
    }
    return Response.json(
      { message: "Could not save this workspace. Please try again." },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  let streamCancelled = false;
  const generationAbortController = new AbortController();
  const abortGeneration = () => {
    if (!generationAbortController.signal.aborted) {
      generationAbortController.abort(request.signal.reason);
    }
  };
  request.signal.addEventListener("abort", abortGeneration, { once: true });
  if (request.signal.aborted) abortGeneration();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) => {
        if (!streamCancelled) controller.enqueue(encoder.encode(chunk));
      };
      let generationCommitted = false;

      try {
        const reservedUser = await db.user.findUnique({
          where: { id: user.id },
          select: { credits: true },
        });
        enqueue(
          sseEvent("started", {
            workspaceId: activeWorkspaceId,
            creditsRemaining:
              reservedUser?.credits ??
              Math.max(0, user.credits - CREDIT_COST_PER_GENERATION),
          })
        );
        enqueue(sseEvent("status", { message: "Thinking…" }));
        enqueue(sseEvent("status", { message: "Preparing your prompt…" }));
        if (generationAbortController.signal.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }
        const contents = await buildContents(
          messagesForModel,
          typedFileData,
          generationAbortController.signal
        );
        if (generationAbortController.signal.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }

        enqueue(sseEvent("status", { message: "Sending request to Gemini…" }));
        const geminiStream = await ai.models.generateContentStream({
          model: "gemini-3.5-flash-lite",
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: "application/json",
            abortSignal: generationAbortController.signal,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MEDIUM,
            },
          },
        });
        enqueue(sseEvent("status", { message: "Generating your app…" }));

        let accumulated = ""; // final JSON output
        let outputStatusSent = false;
        const emittedProgressLabels = new Set<string>();
        const emitProgressLabels = () => {
          for (const label of readStreamedProgressLabels(accumulated)) {
            const cleanLabel = label.trim();
            const wordCount = cleanLabel.split(/\s+/).filter(Boolean).length;
            const key = cleanLabel.toLowerCase();
            if (
              wordCount < 2 ||
              wordCount > 3 ||
              cleanLabel.length > 48 ||
              emittedProgressLabels.has(key) ||
              emittedProgressLabels.size >= 3
            ) {
              continue;
            }
            emittedProgressLabels.add(key);
            enqueue(sseEvent("plan_step", { label: cleanLabel }));
          }
        };

        for await (const chunk of geminiStream) {
          if (generationAbortController.signal.aborted) {
            throw new DOMException("Generation cancelled", "AbortError");
          }
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (!part.text) continue;

            if (part.thought) continue;

            accumulated += part.text;
            // The model puts its short work outline first in the JSON, so these
            // SSE events can reach the UI while the app files are still being
            // generated.
            emitProgressLabels();

            if (!outputStatusSent && /"files"\s*:\s*\{/.test(accumulated)) {
              enqueue(sseEvent("status", { message: "Writing app files…" }));
              outputStatusSent = true;
            }
          }
        }

        // ── Parse the complete JSON response ──────────────────────────────────

        let parsed: {
          progress?: string[];
          assistantMessage: string;
          title?: string;
          files: Record<string, { code: string }>;
          dependencies: Record<string, string>;
        };

        try {
          parsed = JSON.parse(accumulated);
        } catch {
          enqueue(
            sseEvent("error", {
              message: "AI returned invalid JSON. Please try again.",
            })
          );
          return;
        }

        const {
          assistantMessage,
          title: aiTitle,
          files,
          dependencies,
        } = parsed;

        if (!files || typeof files !== "object") {
          enqueue(
            sseEvent("error", {
              message: "AI response missing files. Please try again.",
            })
          );
          return;
        }

        // ── Validate npm packages ──────────────────────────────────────────────

        enqueue(sseEvent("status", { message: "Validating packages…" }));
        const validatedDeps = await validateDependencies(dependencies ?? {});
        if (generationAbortController.signal.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }
        const newFileData: FileData = {
          files,
          dependencies: validatedDeps,
          // Keep the app's original name on follow-up generations. The model
          // may otherwise turn an edit prompt into a new, awkward title.
          title: typedFileData?.title ?? aiTitle,
        };

        // ── Save workspace (credit was reserved before generation) ────────────

        enqueue(sseEvent("status", { message: "Saving…" }));

        const updatedMessages: Message[] = [
          ...typedMessages,
          { role: "assistant", content: assistantMessage },
        ];

        const [workspace] = await db.$transaction([
          db.workspace.update({
            where: { id: activeWorkspaceId!, userId: user.id },
            data: {
              ...(typedFileData?.title
                ? {}
                : {
                    title:
                      aiTitle ?? latestUserMessage.content.slice(0, 80),
                  }),
              messages: updatedMessages as never,
              fileData: newFileData as never,
            },
          }),
        ]);
        generationCommitted = true;

        const updatedUser = await db.user.findUnique({
          where: { id: userId },
          select: { credits: true },
        });

        // ── Emit final result ──────────────────────────────────────────────────

        enqueue(
          sseEvent("done", {
            workspaceId: workspace.id,
            assistantMessage,
            fileData: newFileData,
            creditsRemaining:
              updatedUser?.credits ?? user.credits - CREDIT_COST_PER_GENERATION,
          })
        );
      } catch (err) {
        if (!generationAbortController.signal.aborted) {
          console.error("[gen-ai-code] stream error:", err);
          const providerStatus =
            typeof err === "object" && err !== null && "status" in err
              ? Number(err.status)
              : null;
          enqueue(
            sseEvent("error", {
              message:
                providerStatus === 503
                  ? "Gemini is temporarily busy. Please retry in a moment."
                  : "Something went wrong. Your prompt is saved; please retry.",
            })
          );
        }
      } finally {
        request.signal.removeEventListener("abort", abortGeneration);
        if (!generationCommitted) {
          try {
            const refundedUser = await db.user.update({
              where: { id: user.id },
              data: { credits: { increment: CREDIT_COST_PER_GENERATION } },
              select: { credits: true },
            });
            enqueue(
              sseEvent("credits", { creditsRemaining: refundedUser.credits })
            );
          } catch (refundError) {
            console.error("[gen-ai-code] credit refund error:", refundError);
          }
        }
        if (!streamCancelled) controller.close();
      }
    },
    cancel() {
      streamCancelled = true;
      abortGeneration();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300; // for vercel - 300s on Fluid
