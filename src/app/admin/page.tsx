import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AdminApp from "@/components/AdminApp";

const clean = (value: string) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

export default async function AdminPage() {
  const host = clean((await headers()).get("host") || "");
  const adminHost = clean(process.env.ADMIN_HOST || "");
  const isLocalhost = host === "localhost" || host.startsWith("localhost:");

  if (adminHost ? host !== adminHost : !isLocalhost) {
    redirect("/customer");
  }

  return <AdminApp />;
}
