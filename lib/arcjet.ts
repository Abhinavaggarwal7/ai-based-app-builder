import arcjet, {
  tokenBucket,
  detectPromptInjection,
  sensitiveInfo,
} from "@arcjet/next";

// Route-level Arcjet client for the AI generation and improve APIs.
// shield + detectBot handled globally in proxy.ts,
// Characteristics: "userId" means each Clerk user gets their own token bucket,
// so corporate offices / VPNs sharing an IP don't share rate limits.

export const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  characteristics: ["userId"],
  rules: [
    // ── Per-user rate limit ────────────────────────────────────────────────
    // Token bucket: 5 AI operations per 60 seconds per user, shared by both routes.
    // Each call to aj.protect() costs `requested` tokens (we pass 1).
    // Adjust refillRate / capacity for your plans as needed.
    tokenBucket({
      mode: "LIVE",
      refillRate: 5, // refill 5 tokens every...
      interval: 60, // ...60 seconds
      capacity: 5, // max burst = 5
    }),

    // ── Prompt injection detection ─────────────────────────────────────────
    // Blocks prompt injection before it reaches the AI provider. Each route
    // passes its latest user message via detectPromptInjectionMessage.
    detectPromptInjection({
      mode: "LIVE",
    }),

    // ── Sensitive information ──────────────────────────────────────────────
    // Block common PII before the prompt is sent to an AI provider.
    sensitiveInfo({
      mode: "LIVE",
      deny: ["CREDIT_CARD_NUMBER", "EMAIL", "PHONE_NUMBER"],
    }),
  ],
});
