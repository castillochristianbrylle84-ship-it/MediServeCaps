import { headers } from "next/headers";
import { getAdminAuth } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // 1. Only answer on the admin site
  const host = (await headers()).get("host") || "";
  const adminHost = process.env.ADMIN_HOST;
  const ok = adminHost ? host === adminHost : host.startsWith("localhost");
  if (!ok) return Response.json({ error: "Not found" }, { status: 404 });

  // 2. Get the Firebase token from the browser
  const token = req.headers.get("authorization")?.split("Bearer ")[1];
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // 3. Verify the token
    const decoded = await getAdminAuth().verifyIdToken(token);

    // 4. Must be an admin (claim, or email on the allowed list)
    const allowed = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const isAdmin =
      decoded.admin === true ||
      (!!decoded.email && allowed.includes(decoded.email.toLowerCase()));

    if (!isAdmin) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return Response.json({ admin: true });
  } catch (err) {
    console.error("Admin session error:", err);
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}