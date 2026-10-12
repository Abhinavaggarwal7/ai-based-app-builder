import { auth } from "@clerk/nextjs/server";
import JSZip from "jszip";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { BASE_EXPORT_DEPENDENCIES } from "@/lib/exportConfig";

const exportRequestSchema = z.object({
  files: z
    .record(
      z.string().min(1).max(200),
      z.object({ code: z.string().max(1_000_000) })
    )
    .refine((files) => Object.keys(files).length > 0, "No files to export")
    .refine((files) => Object.keys(files).length <= 100, "Too many files")
    .refine(
      (files) =>
        Object.values(files).reduce((total, file) => total + file.code.length, 0) <=
        4_000_000,
      "Project is too large to export"
    )
    .refine(
      (files) =>
        Object.keys(files).every((path) => {
          const normalizedPath = path.replace(/^\/+/, "");
          return (
            !path.includes("\\") &&
            normalizedPath.length > 0 &&
            normalizedPath.split("/").every((part) => part && part !== "." && part !== "..")
          );
        }),
      "Invalid file path"
    ),
  dependencies: z
    .record(z.string().min(1).max(200), z.string().min(1).max(100))
    .refine((dependencies) => Object.keys(dependencies).length <= 100),
  title: z.string().max(120).optional(),
});

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Please sign in to download this project." }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 5_000_000) {
    return Response.json({ message: "Project is too large to export." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid export request." }, { status: 400 });
  }

  const parsed = exportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ message: "Project files could not be exported." }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { plan: true },
  });

  if (!user) {
    return Response.json({ message: "User account not found." }, { status: 404 });
  }

  if (user.plan !== "pro") {
    return Response.json({ message: "ZIP downloads are available on the Pro plan." }, { status: 403 });
  }

  const { files, dependencies, title } = parsed.data;
  const zip = new JSZip();
  const packageJson = {
    name: "forge-app",
    version: "1.0.0",
    private: true,
    dependencies: {
      react: "^18.2.0",
      "react-dom": "^18.2.0",
      "react-scripts": "5.0.1",
      ...BASE_EXPORT_DEPENDENCIES,
      ...dependencies,
    },
    scripts: {
      start: "react-scripts start",
      build: "react-scripts build",
    },
    browserslist: {
      production: [">0.2%", "not dead", "not op_mini all"],
      development: ["last 1 chrome version"],
    },
  };

  zip.file("package.json", JSON.stringify(packageJson, null, 2));
  zip.file(
    "public/index.html",
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${(title ?? "Forge App").replace(/[<>"'&]/g, "")}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
  );

  for (const [filePath, fileObj] of Object.entries(files)) {
    const zipPath = filePath.replace(/^\/+/, "");
    zip.file(`src/${zipPath}`, fileObj.code);
  }

  zip.file(
    "src/index.js",
    `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);`
  );
  zip.file(
    "README.md",
    `# Forge App\n\nGenerated with [Forge](https://forge.app).\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\``
  );

  const archive = await zip.generateAsync({ type: "uint8array" });
  const safeTitle = title
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = safeTitle ? `${safeTitle}.zip` : "forge-app.zip";
  const responseBody = new ArrayBuffer(archive.byteLength);
  new Uint8Array(responseBody).set(archive);

  return new Response(responseBody, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
