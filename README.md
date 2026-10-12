# Forge — AI App Builder

Forge turns a natural-language prompt into a small React app. It saves the chat and generated files, then shows the app in a Sandpack preview. Users can ask for another generation, use the Pro-only improvement agent, and reopen saved workspaces.

## Features

- Prompt-based React and Tailwind code generation with Gemini 3.5 Flash Lite.
- Server-Sent Events (SSE) for generation and agent progress updates.
- Sandpack preview and read-only source browser.
- Persistent workspaces and project history, stored in PostgreSQL through Prisma.
- Screenshot uploads for Starter and Pro users, stored in Supabase Storage.
- “Fix with AI” sends preview errors through the normal Gemini generation flow.
- “Improve with Forge Agent” uses the Cline SDK and is limited to Pro users.
- ZIP export is limited to Pro users.
- Clerk authentication and billing, credit tracking, and Arcjet request protections.

## Plans

The app currently configures these credit allocations in `lib/constants.ts`:

| Plan | Credits | Features |
| --- | ---: | --- |
| Free | 10 | Live preview |
| Starter | 50 | Live preview, image uploads |
| Pro | 150 | Live preview, image uploads, ZIP export, AI improvement agent |

Generation and improvement each cost one credit. The feature descriptions shown in Clerk Billing are configured separately in the Clerk dashboard.

## Tech stack

- Next.js 16 App Router, React 19, and TypeScript
- Clerk for authentication and billing
- PostgreSQL, Prisma 7, and the Prisma Postgres adapter
- Supabase Storage for uploaded images
- Gemini API for code generation and the Cline improvement agent
- Arcjet for request shielding, bot detection, per-user rate limits, prompt-injection checks, and sensitive-information checks
- Sandpack for the generated app preview

## Run locally

Requirements: Node.js 22+, a PostgreSQL database, a Clerk application, a Gemini API key, an Arcjet key, and a Supabase project with a `workspace-images` storage bucket and service role key.

```bash
git clone https://github.com/Abhinavaggarwal7/ai-based-app-builder.git
cd ai-based-app-builder
npm install
```

Copy `.env.example` to `.env` and fill in the credentials. Then apply the checked-in database migrations and start the dev server:

```bash
npx prisma migrate deploy
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

```env
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_STARTER_PLAN_ID=
NEXT_PUBLIC_CLERK_PRO_PLAN_ID=

# Supabase Storage
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# PostgreSQL / Prisma
DATABASE_URL=
DIRECT_URL=

# AI and request protection
GEMINI_API_KEY=
ARCJET_KEY=
```

`DATABASE_URL` is used by the app at runtime. `DIRECT_URL` is used by Prisma CLI migrations. Keep secret values out of source control.
`SUPABASE_SERVICE_ROLE_KEY` is used only by the authenticated image upload API route; keep it secret and never expose it with a `NEXT_PUBLIC_` prefix.

## Data model

- `User` stores a Clerk ID, profile details, plan, credits, and timestamps.
- `Workspace` belongs to a user and stores the chat messages and generated file data as JSON.
- Uploaded images are stored in the Supabase `workspace-images` bucket. The application returns public URLs, so bucket configuration determines whether those URLs can be accessed by anyone who has them.
