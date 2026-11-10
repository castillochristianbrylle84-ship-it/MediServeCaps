import { headers } from "next/headers";
import { redirect } from "next/navigation";
// ...your existing imports stay here

export default async function CustomerPage() {
  const host = (await headers()).get("host") || "";
  const adminHost = process.env.ADMIN_HOST || "";

  if (adminHost && host === adminHost) {
    redirect("/admin");
  }

  // ...your existing return stays here
}