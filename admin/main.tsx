import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "../src/components/AdminApp";
import "../src/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>
);