import CustomerApp from "@/components/CustomerApp";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MediServe – Get Your Queue Number",
};

export default function CustomerPage() {
  return <CustomerApp />;
}
