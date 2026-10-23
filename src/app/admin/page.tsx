import AdminApp from "@/components/AdminApp";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MediServe Admin Panel",
};

export default function AdminPage() {
  return <AdminApp />;
}
