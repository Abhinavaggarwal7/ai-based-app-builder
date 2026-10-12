import { randomUUID } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/lib/prisma";

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Please sign in to upload an image." }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, plan: true },
  });
  if (!user) {
    return Response.json({ message: "User account not found." }, { status: 404 });
  }
  if (user.plan !== "starter" && user.plan !== "pro") {
    return Response.json(
      { message: "Image uploads are available on Starter and Pro plans." },
      { status: 403 }
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 11 * 1024 * 1024) {
    return Response.json({ message: "Images must be 10 MB or smaller." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ message: "Invalid image upload." }, { status: 400 });
  }

  const image = formData.get("image");
  if (!(image instanceof File)) {
    return Response.json({ message: "Choose an image to upload." }, { status: 400 });
  }
  const supportedImageTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ];
  if (!supportedImageTypes.includes(image.type)) {
    return Response.json({ message: "Use a PNG, JPEG, WebP, HEIC, or HEIF image." }, { status: 400 });
  }
  if (image.size > 10 * 1024 * 1024) {
    return Response.json({ message: "Images must be 10 MB or smaller." }, { status: 413 });
  }

  const workspaceId = formData.get("workspaceId");
  let workspaceFolder = "new";
  if (typeof workspaceId === "string" && workspaceId) {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, userId: user.id },
      select: { id: true },
    });
    if (!workspace) {
      return Response.json({ message: "Workspace not found." }, { status: 404 });
    }
    workspaceFolder = workspace.id;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // This API route has already authenticated the Clerk user and checked their
  // plan/workspace ownership. Use a server-only key here because Supabase's
  // anon key is subject to Storage RLS and does not carry the Clerk session.
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return Response.json({ message: "Image storage is not configured." }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const extension =
    image.type === "image/jpeg"
      ? "jpg"
      : (image.type.split("/")[1]?.split("+")[0] ?? "img").replace(/[^a-z0-9]/gi, "") || "img";
  const path = `${user.id}/${workspaceFolder}/${randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("workspace-images")
    .upload(path, image, { contentType: image.type, upsert: false });

  if (error) {
    console.error("[upload-image] Supabase Storage upload failed", {
      status: error.status,
      statusCode: error.statusCode,
      message: error.message,
    });
    return Response.json({ message: "Image upload failed. Please try again." }, { status: 502 });
  }

  const { data } = supabase.storage.from("workspace-images").getPublicUrl(path);
  return Response.json({ imageUrl: data.publicUrl });
}
