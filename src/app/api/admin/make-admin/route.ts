export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { error: "Admin role assignment is disabled through the public API." },
    { status: 410 }
  );
}