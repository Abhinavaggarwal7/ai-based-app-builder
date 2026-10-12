// WorkspaceClient.tsx
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ChatPanel } from "./ChatPanel";
import { CodePanel } from "./CodePanel";
import { MobileBlocker } from "./MobileBlocker";
import { MIN_CREDITS_TO_GENERATE } from "@/lib/constants";
import { toast } from "sonner";
import type {
  Message,
  FileData,
  StatusStep,
  WorkspaceData,
} from "@/types/workspace";

export type {
  MessageRole,
  Message,
  FileData,
  StatusStep,
} from "@/types/workspace";

interface WorkspaceClientProps {
  initialPrompt: string | null;
  workspace: WorkspaceData | null;
  userCredits: number;
  userId: string;
  userPlan: string;
}

function parseMessages(raw: unknown): Message[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is Message =>
      typeof m === "object" && m !== null && "role" in m && "content" in m
  );
}

function parseFileData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (!f.files || !f.dependencies) return null;
  return raw as FileData;
}

function setCreditsAndNotify(
  setCredits: (credits: number) => void,
  value: unknown
) {
  const credits = Number(value);
  if (!Number.isFinite(credits)) return;

  setCredits(credits);
  window.dispatchEvent(
    new CustomEvent("forge:credits-updated", { detail: { credits } })
  );
}

export function WorkspaceClient({
  initialPrompt,
  workspace,
  userCredits,
  userId,
  userPlan,
}: WorkspaceClientProps) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    workspace?.id ?? null
  );
  const [messages, setMessages] = useState<Message[]>(
    parseMessages(workspace?.messages)
  );
  const [fileData, setFileData] = useState<FileData | null>(
    parseFileData(workspace?.fileData)
  );
  const [credits, setCredits] = useState(userCredits);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusLog, setStatusLog] = useState<StatusStep[]>([]);
  const [isImproving, setIsImproving] = useState(false);

  // AbortController refs — used to cancel in-flight streams
  const generateAbortRef = useRef<AbortController | null>(null);
  const improveAbortRef = useRef<AbortController | null>(null);

  // Refs to avoid stale closures in callbacks
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const workspaceIdRef = useRef<string | null>(workspaceId);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // fileData ref — so handleImprove never closes over stale fileData
  // even as file_patch events stream in
  const fileDataRef = useRef<FileData | null>(fileData);
  useEffect(() => {
    fileDataRef.current = fileData;
  }, [fileData]);

  const pushStep = (label: string) => {
    setStatusLog((prev) => [
      ...prev.map((s, i) =>
        s.status === "running" ? { ...s, status: "done" as const } : s
      ),
      { label, status: "running" as const },
    ]);
  };

  const completeSteps = () => {
    setStatusLog((prev) =>
      prev.map((s) => ({ ...s, status: "done" as const }))
    );
  };

  const handleGenerate = useCallback(
    async (prompt: string, imageUrl?: string, resumePending = false) => {
      if (isGenerating) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;

      const currentMessages = messagesRef.current;
      const currentWorkspaceId = workspaceIdRef.current;
      const pendingMessage = currentMessages[currentMessages.length - 1];
      const userMessage: Message = resumePending
        ? pendingMessage
        : {
            role: "user",
            content: prompt,
            ...(imageUrl ? { imageUrl } : {}),
          };

      if (!userMessage || userMessage.role !== "user") return;

      if (!resumePending) setMessages((prev) => [...prev, userMessage]);
      setIsGenerating(true);
      // Progress entries are appended from server-sent events.
      setStatusLog([]);

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      generateAbortRef.current = abortController;

      try {
        const conversationHistory = resumePending
          ? currentMessages
          : [...currentMessages, userMessage];

        const res = await fetch("/api/gen-ai-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            workspaceId: currentWorkspaceId,
            userId,
            messages: conversationHistory,
            fileData: fileDataRef.current,
          }),
        });

        if (res.status === 402) {
          toast.error("Not enough credits.");
          return;
        }
        if (res.status === 429) {
          toast.error("Too many requests. Please slow down.");
          return;
        }
        if (res.status === 400) {
          const data = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          toast.error(data?.message ?? "Please rephrase your prompt.");
          return;
        }
        if (!res.ok || !res.body) throw new Error("Generation failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamErrorMessage: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: { type?: string; [key: string]: unknown };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              // skip malformed SSE lines
              continue;
            }

            if (event.type === "status") {
              pushStep(String(event.message ?? ""));
            } else if (event.type === "plan_step") {
              setStatusLog((prev) => [
                ...prev,
                { label: String(event.label ?? "Planning task"), status: "planned" },
              ]);
            } else if (event.type === "started") {
              const id = String(event.workspaceId);
              setWorkspaceId(id);
              setCreditsAndNotify(setCredits, event.creditsRemaining);
              window.history.replaceState(null, "", `/workspace?id=${id}`);
            } else if (event.type === "credits") {
              setCreditsAndNotify(setCredits, event.creditsRemaining);
            } else if (event.type === "done") {
              completeSteps();
              setWorkspaceId(String(event.workspaceId));
              setFileData(event.fileData as FileData);
              setCreditsAndNotify(setCredits, event.creditsRemaining);
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: String(event.assistantMessage ?? "") },
              ]);
              window.history.replaceState(
                null,
                "",
                `/workspace?id=${String(event.workspaceId)}`
              );
            } else if (event.type === "error") {
              streamErrorMessage = String(event.message ?? "Generation failed.");
            }
          }
        }
        if (streamErrorMessage) throw new Error(streamErrorMessage);
      } catch (err) {
        // Keep the prompt so the user can retry after a stop or interruption.
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        // This error is already handled here and shown to the user below.
        // In Next.js dev, console.error opens the full-screen error overlay even
        // though the SSE error was caught, so keep it as a warning instead.
        console.warn("[generation] request failed:", err);
        toast.error(
          err instanceof Error ? err.message : "Something went wrong."
        );
      } finally {
        generateAbortRef.current = null;
        setIsGenerating(false);
        setStatusLog([]);
      }
    },
    [credits, isGenerating, userId]
    // fileData intentionally omitted — read via fileDataRef
  );

  const handleRetryGeneration = useCallback(() => {
    const pendingMessage = messagesRef.current[messagesRef.current.length - 1];
    if (pendingMessage?.role !== "user") return Promise.resolve();
    return handleGenerate(pendingMessage.content, pendingMessage.imageUrl, true);
  }, [handleGenerate]);

  const handleImprove = useCallback(
    async (userRequest: string) => {
      if (isGenerating || isImproving) return;
      if (credits < MIN_CREDITS_TO_GENERATE) return;
      if (!workspaceIdRef.current) return;

      // Read fileData from ref — never stale, never causes recreating this fn
      const currentFileData = fileDataRef.current;
      if (!currentFileData) return;

      setIsImproving(true);

      setMessages((prev) => [
        ...prev,
        { role: "user", content: userRequest },
        { role: "assistant", content: "" }, // placeholder, updated live
      ]);

      // Create a fresh AbortController for this request
      const abortController = new AbortController();
      improveAbortRef.current = abortController;

      try {
        const res = await fetch("/api/improve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            userId,
            workspaceId: workspaceIdRef.current,
            userRequest,
            fileData: currentFileData,
          }),
        });

        if (res.status === 429) {
          toast.error("Too many requests. Please wait and try again.");
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        if (res.status === 403) {
          const data = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          toast.error(
            data?.message === "Upgrade required"
              ? "Upgrade to Pro to use Improve with Forge Agent."
              : data?.message ?? "Request blocked."
          );
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        if (res.status === 402) {
          toast.error("Not enough credits.");
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        if (res.status === 400) {
          const data = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          toast.error(data?.message ?? "Please revise your request.");
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        if (!res.ok || !res.body) throw new Error("Improve failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedThinking = "";
        let streamErrorMessage: string | null = null;

        // Accumulate patches locally — only apply to state at done.
        // Applying on every file_patch event would update fileData state,
        // which feeds into SandpackProvider and can cause remounts mid-stream.
        const localPatches: Record<string, { code: string }> = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event: { type?: string; [key: string]: unknown };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              // skip malformed SSE lines
              continue;
            }

            if (event.type === "thinking") {
              // Stream agent reasoning into the placeholder assistant message
              accumulatedThinking += String(event.text ?? "");
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: accumulatedThinking,
                };
                return updated;
              });
            } else if (event.type === "started") {
              setCreditsAndNotify(setCredits, event.creditsRemaining);
            } else if (event.type === "credits") {
              setCreditsAndNotify(setCredits, event.creditsRemaining);
            } else if (event.type === "file_patch") {
              // Accumulate locally — don't touch state yet
              localPatches[String(event.path)] = { code: String(event.code ?? "") };
            } else if (event.type === "done") {
              // Apply all patches at once now that the stream is complete
              setFileData(event.fileData as FileData);
              setCreditsAndNotify(setCredits, event.creditsRemaining);
              // Replace thinking text with clean summary
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: String(event.summary ?? ""),
                };
                return updated;
              });
            } else if (event.type === "error") {
              streamErrorMessage = String(event.message ?? "Improve failed.");
            }
          }
        }
        if (streamErrorMessage) throw new Error(streamErrorMessage);
      } catch (err) {
        // User-initiated stop — silently roll back the user + placeholder messages
        if (err instanceof Error && err.name === "AbortError") {
          setMessages((prev) => prev.slice(0, -2));
          return;
        }
        toast.error(err instanceof Error ? err.message : "Improve failed.");
        setMessages((prev) => prev.slice(0, -2));
      } finally {
        improveAbortRef.current = null;
        setIsImproving(false);
      }
    },
    // fileData intentionally omitted — read via fileDataRef above
    [credits, isGenerating, isImproving, userId]
  );

  // Cancel whichever stream is currently in-flight
  const handleStop = useCallback(() => {
    generateAbortRef.current?.abort();
    improveAbortRef.current?.abort();
  }, []);

  return (
    <>
      {/* Mobile blocker — visible only on small screens */}
      <div className="md:hidden">
        <MobileBlocker />
      </div>

      {/* Workspace — visible only on md+ screens */}
      <div className="hidden md:flex h-[calc(100vh-3.5rem)] overflow-hidden bg-[#0a0a0a]">
        <ChatPanel
          isImproving={isImproving}
          messages={messages}
          isGenerating={isGenerating}
          statusLog={statusLog}
          credits={credits}
          initialPrompt={initialPrompt}
          onGenerate={handleGenerate}
          onRetry={handleRetryGeneration}
          onStop={handleStop}
          workspaceId={workspaceId}
          appTitle={workspace?.title ?? fileData?.title ?? null}
          canUploadImages={userPlan === "starter" || userPlan === "pro"}
        />
        <div className="w-px shrink-0 bg-white/6" />
        <CodePanel
          fileData={fileData}
          isGenerating={isGenerating}
          statusLog={statusLog}
          onImprove={handleImprove}
          onFixError={(error) =>
            handleGenerate(
              `There is an error in the preview:\n\n\`\`\`\n${error}\n\`\`\`\n\nPlease fix it.`
            )
          }
          appTitle={workspace?.title ?? fileData?.title ?? null}
          isImproving={isImproving}
          isProUser={userPlan === "pro"}
        />
      </div>
    </>
  );
}
