import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { Agent, createTool } from "@cline/sdk";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import { aj } from "@/lib/arcjet";
import type { FileData } from "@/types/workspace";

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sseEvent(type: string, payload: object): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return Response.json({ message: "Unauthorized" }, { status: 401 });

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
  const { userId, workspaceId, userRequest, fileData } = requestBody;
  if (
    typeof userId !== "string" ||
    !userId ||
    typeof workspaceId !== "string" ||
    !workspaceId ||
    typeof userRequest !== "string" ||
    !userRequest.trim() ||
    userRequest.length > 20_000 ||
    !fileData ||
    typeof fileData !== "object" ||
    Array.isArray(fileData) ||
    !("files" in fileData) ||
    !fileData.files ||
    typeof fileData.files !== "object" ||
    Array.isArray(fileData.files) ||
    !("dependencies" in fileData) ||
    !fileData.dependencies ||
    typeof fileData.dependencies !== "object" ||
    Array.isArray(fileData.dependencies)
  ) {
    return Response.json({ message: "Invalid request data." }, { status: 400 });
  }
  const typedFileData = fileData as FileData;

  // ── Auth + credit check ────────────────────────────────────────────────────

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true, plan: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  // Pro-only gate
  if (user.plan !== "pro")
    return Response.json({ message: "Upgrade required" }, { status: 403 });

  const workspace = await db.workspace.findFirst({
    where: { id: workspaceId, userId: user.id },
    select: { id: true },
  });
  if (!workspace) {
    return Response.json({ message: "Workspace not found" }, { status: 404 });
  }

  // Apply the same per-user AI protections as the regular generation route.
  const arcjetRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });

  const decision = await aj.protect(arcjetRequest, {
    requested: 1,
    userId: clerkId,
    detectPromptInjectionMessage: userRequest,
    sensitiveInfoValue: userRequest,
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
        { message: "Prompt injection detected. Please rephrase your request." },
        { status: 400 }
      );
    }

    if (decision.reason.isSensitiveInfo()) {
      return Response.json(
        {
          message:
            "Sensitive information detected. Remove personal or payment details from your request.",
        },
        { status: 400 }
      );
    }

    return Response.json(
      { message: "Request blocked by security checks." },
      { status: 403 }
    );
  }

  // Reserve a credit atomically before starting the agent. Concurrent requests
  // cannot both spend the same last credit.
  const reservation = await db.user.updateMany({
    where: {
      id: user.id,
      credits: { gte: CREDIT_COST_PER_GENERATION },
    },
    data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
  });

  if (reservation.count === 0)
    return Response.json({ message: "Insufficient credits" }, { status: 402 });

  // ── Build the agent ────────────────────────────────────────────────────────

  const encoder = new TextEncoder();
  let streamCancelled = false;
  const improveAbortController = new AbortController();
  let abortAgent: (() => void) | null = null;
  const abortImprovement = () => {
    if (!improveAbortController.signal.aborted) {
      improveAbortController.abort(request.signal.reason);
    }
    abortAgent?.();
  };
  request.signal.addEventListener("abort", abortImprovement, { once: true });
  if (request.signal.aborted) abortImprovement();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) => {
        if (!streamCancelled) controller.enqueue(encoder.encode(chunk));
      };
      let improvementCommitted = false;

      try {
        const reservedUser = await db.user.findUnique({
          where: { id: user.id },
          select: { credits: true },
        });
        enqueue(
          sseEvent("started", {
            creditsRemaining:
              reservedUser?.credits ??
              Math.max(0, user.credits - CREDIT_COST_PER_GENERATION),
          })
        );

        if (improveAbortController.signal.aborted) {
          throw new DOMException("Improvement cancelled", "AbortError");
        }
        // Accumulate file patches as the agent calls update_file
        const patchedFiles: Record<string, { code: string }> = {
          ...typedFileData.files,
        };
        let finalSummary = "";

        // ── Tool 1: update_file ──────────────────────────────────────────────
        // The agent calls this once per file it wants to change.
        // We immediately emit a file_patch SSE event so Sandpack
        // updates live in the browser as each file is patched.

        const updateFileTool = createTool({
          name: "update_file",
          description:
            "Update or rewrite a file in the React sandbox. Call once per file you need to change.",
          inputSchema: z.object({
            path: z
              .string()
              .describe("File path exactly as it appears, e.g. /App.js"),
            code: z.string().describe("Complete new contents of the file"),
            reason: z
              .string()
              .describe("One sentence explaining what you changed and why"),
          }),
          async execute({ path, code, reason }) {
            patchedFiles[path] = { code };
            // Emit live patch — client applies it to Sandpack immediately
            enqueue(sseEvent("file_patch", { path, code, reason }));
            return `Updated ${path}: ${reason}`;
          },
        });

        // ── Tool 2: done_improving ───────────────────────────────────────────
        // Agent calls this when all files are updated.
        // lifecycle.completesRun: true tells the Cline SDK loop to stop
        // immediately after this tool runs instead of continuing iterations.

        const doneImprovingTool = createTool({
          name: "done_improving",
          description:
            "Call this when you have finished making all improvements.",
          inputSchema: z.object({
            summary: z
              .string()
              .describe(
                "A short friendly summary of all the improvements you made (1-3 sentences)"
              ),
          }),
          lifecycle: { completesRun: true },
          async execute({ summary }) {
            finalSummary = summary;
            return "Done.";
          },
        });

        // ── Serialize current files for context ──────────────────────────────
        // We give the agent all current files as context in the system prompt
        // so it knows exactly what it's working with.

        const fileContext = Object.entries(typedFileData.files)
          .map(([path, { code }]) => `// ${path}\n${code}`)
          .join("\n\n---\n\n");

        const agent = new Agent({
          providerId: "gemini",
          modelId: "gemini-3.5-flash-lite",
          apiKey: process.env.GEMINI_API_KEY!,
          maxIterations: 8,
          systemPrompt: `You are an expert React developer improving a live browser preview app.

The app uses React (functional components), Tailwind CSS for styling, and runs in Sandpack.
You CANNOT use TypeScript, CSS modules, or real npm install — only what's already available.
Available packages: react, react-dom, tailwindcss (CDN), lucide-react, recharts, react-router-dom, framer-motion, date-fns, zod, react-hook-form.

Here are the current files:

${fileContext}

WORKFLOW:
1. Understand what the user wants improved.
2. Identify which files need to change.
3. Call update_file for each file that needs changes (always include the COMPLETE file, not just the diff).
4. Once all files are updated, call done_improving with a short summary.

RULES:
- Always write complete file contents — never partial snippets.
- Keep all existing functionality unless asked to remove it.
- The entry point is always /App.js with a default export.
- All imports must reference files you've updated or packages in the available list above.`,
          tools: [updateFileTool, doneImprovingTool],
          // Auto-approve both tools — no human-in-the-loop needed in this context
          toolPolicies: {
            update_file: { autoApprove: true },
            done_improving: { autoApprove: true },
          },
        });
        abortAgent = () =>
          agent.abort(new DOMException("Improvement cancelled", "AbortError"));
        if (improveAbortController.signal.aborted) abortAgent();

        // ── Stream agent reasoning to chat panel ─────────────────────────
        // assistant-text-delta fires as the agent types its reasoning.
        // We emit these as "thinking" events — shown in the chat panel
        // as a live streaming message so users see the agent working.

        agent.subscribe((event) => {
          if (event.type === "assistant-text-delta" && event.text) {
            enqueue(sseEvent("thinking", { text: event.text }));
          }

          // This fires reliably every time a tool is called
          if (event.type === "tool-started") {
            const name = event.toolCall?.toolName;
            if (name === "update_file") {
              const path =
                (event.toolCall?.input as { path?: string })?.path ?? "a file";
              enqueue(
                sseEvent("thinking", { text: `\n\nUpdating \`${path}\`…` })
              );
            } else if (name === "done_improving") {
              enqueue(
                sseEvent("thinking", { text: "\n\nFinalizing improvements…" })
              );
            }
          }
        });

        // ── Run the agent ─────────────────────────────────────────────────
        enqueue(sseEvent("status", { message: "Cline agent starting…" }));

        const result = await agent.run(userRequest);
        if (improveAbortController.signal.aborted) {
          throw new DOMException("Improvement cancelled", "AbortError");
        }

        if (result.status === "failed") {
          throw new Error(result.error?.message ?? "Agent run failed");
        }

        // ── Save to DB (credit was reserved before the agent started) ──────

        const newFileData: FileData = {
          files: patchedFiles,
          dependencies: typedFileData.dependencies,
          title: typedFileData.title,
        };

        if (improveAbortController.signal.aborted) {
          throw new DOMException("Improvement cancelled", "AbortError");
        }

        await db.$transaction([
          db.workspace.update({
            where: { id: workspaceId, userId },
            data: { fileData: newFileData as never },
          }),
        ]);
        improvementCommitted = true;

        const updatedUser = await db.user.findUnique({
          where: { id: userId },
          select: { credits: true },
        });

        // ── Final done event ──────────────────────────────────────────────

        enqueue(
          sseEvent("done", {
            fileData: newFileData,
            summary: finalSummary || result.outputText,
            creditsRemaining:
              updatedUser?.credits ?? user.credits - CREDIT_COST_PER_GENERATION,
          })
        );
      } catch (err) {
        if (!improveAbortController.signal.aborted) {
          console.error("[improve] error:", err);
          enqueue(
            sseEvent("error", {
              message:
                err instanceof Error ? err.message : "Something went wrong.",
            })
          );
        }
      } finally {
        request.signal.removeEventListener("abort", abortImprovement);
        abortAgent = null;
        if (!improvementCommitted) {
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
            console.error("[improve] credit refund error:", refundError);
          }
        }
        if (!streamCancelled) controller.close();
      }
    },
    cancel() {
      streamCancelled = true;
      abortImprovement();
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
