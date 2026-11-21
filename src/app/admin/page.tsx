import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AdminApp from "@/components/AdminApp";

const clean = (v: string) =>
  v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

export default async function AdminPage() {
  const host = clean((await headers()).get("host") || "");
  const adminHost = clean(process.env.ADMIN_HOST || "");

  if (adminHost && host !== adminHost) {
    redirect("/customer");
  }

  return <AdminApp />;
}