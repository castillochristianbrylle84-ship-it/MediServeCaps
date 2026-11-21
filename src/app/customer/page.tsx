import { headers } from "next/headers";
import { redirect } from "next/navigation";
import CustomerApp from "@/components/CustomerApp";

const clean = (value: string) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

export default async function CustomerPage() {
  const host = clean((await headers()).get("host") || "");
  const adminHost = clean(process.env.ADMIN_HOST || "");

  if (adminHost && host === adminHost) {
    redirect("/admin");
  }

  return <CustomerApp />;
}