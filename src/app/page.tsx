import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  const host = (await headers()).get("host") || "";
  const adminHost = process.env.ADMIN_HOST || "";

  if (adminHost && host === adminHost) {
    redirect("/admin");
  }

  // ...keep whatever your home page did before here
}