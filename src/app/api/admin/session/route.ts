import { headers } from "next/headers";

export async function GET() {
	const host = (await headers()).get("host") || "";
	const adminHost = process.env.ADMIN_HOST;
	const ok = adminHost ? host === adminHost : host.startsWith("localhost");
	if (!ok) return Response.json({ error: "Not found" }, { status: 404 });
}