import { headers } from "next/headers";
import { redirect } from "next/navigation";
import CustomerApp from "@/components/CustomerApp";

export default async function Home() {
  const host = (await headers()).get("host") || "";
  const adminHost = process.env.ADMIN_HOST || "";

  if (adminHost && host === adminHost) {
    redirect("/admin");
  }

  return <CustomerApp />;
}