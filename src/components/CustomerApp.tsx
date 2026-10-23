"use client";

import { useEffect, useState, useCallback } from "react";
import {
  subscribeStockItems,
  subscribeQueueEntries,
  addQueueEntry,
  getNextQueueNumber,
  type StockItem,
  type QueueEntry,
} from "@/lib/firestore";

//  Types 
type Page = "home" | "register" | "queue" | "track" | "history";

interface SelectedMedicine {
  name: string;
  quantity: number;
}

interface FormState {
  patientName: string;
  address: string;
  phone: string;
  patientType: "regular" | "pwd";
  selectedMedicines: SelectedMedicine[];
}

async function readApiResponse<T extends { error?: string }>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const responseText = await response.text();
  const bodyPreview = responseText.trim().replace(/\s+/g, " ").slice(0, 500);

  if (!contentType.toLowerCase().includes("json")) {
    console.error("OTP API returned a non-JSON response:", {
      status: response.status,
      contentType,
      responseBody: bodyPreview,
    });
    throw new Error(
      `OTP service returned HTTP ${response.status} (${contentType || "unknown content type"}). Check the customer API deployment.`
    );
  }

  let result: T;
  try {
    result = JSON.parse(responseText) as T;
  } catch {
    console.error("OTP API returned invalid JSON:", {
      status: response.status,
      contentType,
      responseBody: bodyPreview,
    });
    throw new Error(`OTP service returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    console.error("OTP API request failed:", {
      status: response.status,
      contentType,
      responseBody: bodyPreview,
    });
    throw new Error(result.error ?? `OTP service returned HTTP ${response.status}.`);
  }

  return result;
}

const STATUS_STEPS = [
  { key: "waiting",    label: "Waiting" },
  { key: "processing", label: "Processing" },
  { key: "getready",   label: "Get Ready" },
  { key: "served",     label: "Served" },
] as const;

function apiEndpoint(path: string): string {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  return apiBaseUrl ? new URL(path, apiBaseUrl).toString() : path;
}

function loadSavedQueueHistory(): string[] {
  if (typeof window === "undefined") return [];

  try {
    const savedIds = window.localStorage.getItem("mediserve-queue-history");
    if (!savedIds) return [];

    const parsed: unknown = JSON.parse(savedIds);
    if (Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string")) {
      return parsed;
    }
    throw new Error("Saved queue history has an invalid format.");
  } catch (error) {
    console.error("Could not load saved queue history:", error);
    return [];
  }
}

// ─── Toast 
function useToast() {
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: string }[]>([]);
  const show = useCallback((msg: string, type = "success") => {
    const id = Date.now();
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 2800);
  }, []);
  return { toasts, show };
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function CustomerApp() {
  const { toasts, show: showToast } = useToast();
  const [page, setPage]               = useState<Page>("home");
  const [medicines, setMedicines]     = useState<StockItem[]>([]);
  const [entries, setEntries]         = useState<QueueEntry[]>([]);
  const [currentId, setCurrentId]     = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpSentFor, setOtpSentFor] = useState<string | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [isRequestingOtp, setIsRequestingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [historyEntryIds, setHistoryEntryIds] = useState<string[]>(loadSavedQueueHistory);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [availableSearchInput, setAvailableSearchInput] = useState("");
  const [availableSearch, setAvailableSearch] = useState("");
  const [neededSearchInput, setNeededSearchInput] = useState("");
  const [neededSearch, setNeededSearch] = useState("");

  const [form, setForm] = useState<FormState>({
    patientName: "",
    address: "",
    phone: "",
    patientType: "regular",
    selectedMedicines: [],
  });

  // Subscribe to Firestore in real-time
  useEffect(() => {
    const unsubStock  = subscribeStockItems(setMedicines);
    const unsubQueue  = subscribeQueueEntries(setEntries);
    return () => { unsubStock(); unsubQueue(); };
  }, []);

  const historyEntries = entries.filter((entry) => historyEntryIds.includes(entry.id));
  const currentEntry = entries.find((e) => e.id === currentId) ?? null;

  // ─── Navigation ────────────────────────────────────────────────────────────
  function navigate(target: Page, id?: string) {
    if (id) setCurrentId(id);
    if (target === "register") {
      setForm({ patientName: "", address: "", phone: "", patientType: "regular", selectedMedicines: [] });
      setOtpCode("");
      setOtpSentFor(null);
      setVerifiedPhone(null);
    }
    setPage(target);
    window.scrollTo(0, 0);
  }

  // ─── Registration Submit ───────────────────────────────────────────────────
  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement, SubmitEvent>) {
  e.preventDefault();

  if (!form.patientName.trim()) { showToast("Please enter your full name", "error"); return; }
  if (!form.address.trim())     { showToast("Please enter your address", "error"); return; }
  if (!/^09\d{9}$/.test(form.phone)) {
    showToast("Please enter a valid 11-digit Philippine mobile number starting with 09", "error");
    return;
  }
  if (verifiedPhone !== form.phone) {
    showToast("Please verify your phone number before registering", "error");
    return;
  }
  if (form.selectedMedicines.length === 0) { showToast("Please select at least one medicine", "error"); return; }

  setIsSubmitting(true);
  try {
    const now = new Date().toISOString();
    const { queueDate, queueNumber } = await getNextQueueNumber(
      form.patientType
    );

    const newId = await addQueueEntry({
      queueDate,
      queueNumber,
      patientName: form.patientName.trim(),
      address: form.address.trim(),
      phone: form.phone.trim(),
      patientType: form.patientType,
      medicines: form.selectedMedicines.map((m) => m.name),
      quantities: form.selectedMedicines.map((m) => m.quantity),
      status: "waiting",
      timestamp: now,
    });

    const nextHistoryIds = [newId, ...historyEntryIds.filter((id) => id !== newId)];
    setHistoryEntryIds(nextHistoryIds);
    try {
      window.localStorage.setItem("mediserve-queue-history", JSON.stringify(nextHistoryIds));
    } catch (error) {
      console.error("Could not save queue history:", error);
      showToast("Queue number created, but it could not be saved to this device's history.", "error");
    }

    showToast("Queue number generated successfully!");
    setTimeout(() => navigate("queue", newId), 800);
  } catch (err: unknown) {
  const e = err as { code?: string; message?: string };
  console.error("Firebase error:", e?.code, e?.message);
  showToast(`Failed: ${e?.code ?? ""} ${e?.message ?? String(err)}`, "error");
  }
}

  async function requestOtp() {
    if (!/^09\d{9}$/.test(form.phone)) {
      showToast("Enter a valid 11-digit Philippine mobile number first", "error");
      return;
    }

    const phone = form.phone;
    setIsRequestingOtp(true);
    try {
      const response = await fetch(apiEndpoint("/api/sms/otp/send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      await readApiResponse<{ error?: string }>(response);
      setOtpSentFor(phone);
      setOtpCode("");
      showToast("Verification code sent by SMS");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not send the verification code.", "error");
    } finally {
      setIsRequestingOtp(false);
    }
  }

  async function verifyPhone() {
    if (!/^\d{6}$/.test(otpCode)) {
      showToast("Enter the 6-digit verification code", "error");
      return;
    }

    setIsVerifyingOtp(true);
    try {
      const response = await fetch(apiEndpoint("/api/sms/otp/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: form.phone, code: otpCode }),
      });
      const result = await readApiResponse<{ error?: string; verified?: boolean }>(response);
      if (!result.verified) throw new Error("Could not verify the code.");
      setVerifiedPhone(form.phone);
      showToast("Phone number verified");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not verify the code.", "error");
    } finally {
      setIsVerifyingOtp(false);
    }
  }

  // ─── Medicine selection helpers ────────────────────────────────────────────
  function toggleMedicine(name: string) {
    setForm((prev) => {
      const exists = prev.selectedMedicines.find((m) => m.name === name);
      return {
        ...prev,
        selectedMedicines: exists
          ? prev.selectedMedicines.filter((m) => m.name !== name)
          : [...prev.selectedMedicines, { name, quantity: 1 }],
      };
    });
  }

  function updateQty(name: string, qty: number) {
    if (qty < 1) return;
    setForm((prev) => ({
      ...prev,
      selectedMedicines: prev.selectedMedicines.map((m) =>
        m.name === name ? { ...m, quantity: qty } : m
      ),
    }));
  }

  // ─── Tracking helpers ──────────────────────────────────────────────────────
  function refreshStatus() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 600);
  }

  // ─── Save queue details as an image ────────────────────────────────────────
  function saveToPhone() {
    if (!currentEntry) return;
    const totalQty = currentEntry.quantities.reduce((a, b) => a + b, 0);
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 760;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.fillStyle = currentEntry.patientType === "pwd" ? "#1d4ed8" : "#166534";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.font = "bold 34px sans-serif";
    context.fillText("MediServe - City Health Pharmacy", canvas.width / 2, 70);
    context.font = "bold 150px sans-serif";
    context.fillText(currentEntry.queueNumber, canvas.width / 2, 245);

    context.textAlign = "left";
    context.font = "bold 28px sans-serif";
    const details = [
      `Patient: ${currentEntry.patientName}`,
      `Type: ${currentEntry.patientType === "pwd" ? "PWD (Priority)" : "Regular"}`,
      `Address: ${currentEntry.address}`,
      `Medicines: ${currentEntry.medicines.map((m, i) => `${m} (x${currentEntry.quantities[i] ?? 1})`).join(", ")}`,
      `Total Quantity: ${totalQty}`,
      `Date: ${new Date(currentEntry.timestamp).toLocaleDateString()}`,
      `Time: ${new Date(currentEntry.timestamp).toLocaleTimeString()}`,
    ];
    details.forEach((detail, index) => context.fillText(detail, 70, 340 + index * 48));
    context.textAlign = "center";
    context.font = "24px sans-serif";
    context.fillText("Please wait for your number to be called.", canvas.width / 2, 700);

    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `queue-${currentEntry.queueNumber}.png`;
    a.click();
    showToast("Queue details saved!");
  }

  const availableMeds = medicines.filter((m) => m.available);
  const searchedAvailableMeds = availableMeds.filter((med) => {
    const query = availableSearch.trim().toLowerCase();
    return !query || med.name.toLowerCase().includes(query) || med.type.toLowerCase().includes(query);
  });
  const searchedNeededMeds = availableMeds.filter((med) => {
    const query = neededSearch.trim().toLowerCase();
    return !query || med.name.toLowerCase().includes(query) || med.type.toLowerCase().includes(query);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="bg-gray-50 min-h-screen">

      {/* ── Toast Stack ── */}
      <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id}
            className={`toast px-6 py-3 rounded-2xl shadow-xl text-white font-medium pointer-events-auto ${
              t.type === "error" ? "bg-red-500" : "bg-[#166534]"
            }`}>{t.msg}</div>
        ))}
      </div>

      {/* ════════════════ HOME PAGE ════════════════ */}
      {page === "home" && (
        <div className="min-h-screen bg-gradient-to-b from-green-50 to-white">
          {/* Header */}
          <div className="bg-[#166534] text-white py-8 px-6 shadow-lg">
            <div className="flex items-center justify-between max-w-2xl mx-auto">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-[#4ade80] rounded-full flex items-center justify-center">
                  <PillIcon className="w-7 h-7 text-[#166534]" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">MediServe</h1>
                  <p className="text-green-200 text-sm">City Health Pharmacy</p>
                </div>
              </div>
            </div>
          </div>

          <div className="px-6 py-6 max-w-2xl mx-auto">
            <div className="mb-8 slide-up" style={{ animationDelay: "0.1s" }}>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Welcome</h2>
              <p className="text-gray-600">Get your queue number and wait comfortably for your turn</p>
            </div>

            <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg mb-8 slide-up" style={{ animationDelay: "0.2s" }}>
              <div className="flex gap-3">
                <AlertIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-900 mb-1">Important Notice</p>
                  <p className="text-sm text-amber-800">Please present your doctor&apos;s prescription to the counter for proper medicine dispensing.</p>
                </div>
              </div>
            </div>

            <div className="mb-8 slide-up" style={{ animationDelay: "0.3s" }}>
              <h3 className="text-xl font-bold text-gray-900 mb-4">Currently Available Medicines</h3>
              <form onSubmit={(e) => { e.preventDefault(); setAvailableSearch(availableSearchInput); }} className="flex gap-2 mb-4">
                <input
                  type="search"
                  value={availableSearchInput}
                  onChange={(e) => setAvailableSearchInput(e.target.value)}
                  placeholder="Search by medicine name or type"
                  aria-label="Search currently available medicines by name or type"
                  className="min-w-0 flex-1 h-11 px-4 rounded-xl border border-gray-300 focus:outline-none focus:border-[#166534]"
                />
                <button type="submit" className="h-11 px-4 bg-[#166534] hover:bg-[#14532d] text-white rounded-xl font-semibold flex items-center gap-2">
                  <SearchIcon className="w-4 h-4" /> Search
                </button>
              </form>
              <div className="grid gap-3">
                {searchedAvailableMeds.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">{availableMeds.length === 0 ? "No medicines currently available" : "No medicines match your search"}</p>
                ) : searchedAvailableMeds.map((med, i) => (
                  <div key={med.id} className="slide-in-left" style={{ animationDelay: `${0.4 + i * 0.05}s` }}>
                    <div className="bg-white border-l-4 border-l-[#4ade80] p-4 rounded-xl hover:shadow-md transition-shadow">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                            <PillIcon className="w-5 h-5 text-[#166534]" />
                          </div>
                          <div>
                            <p className="font-semibold text-gray-900">{med.name}</p>
                            <p className="text-sm text-gray-500">{med.type}</p>
                          </div>
                        </div>
                        <span className="inline-block px-3 py-1 bg-green-100 text-[#166534] rounded text-xs font-semibold">
                          Quantity: {med.stock}
                        </span>
                      </div>
                      <p className={`text-xs font-semibold mt-2 ${med.stock > 10 ? "text-green-700" : "text-red-700"}`}>
                        {med.stock > 10 ? "In Stock" : "Low Stock"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="fixed bottom-0 left-0 right-0 p-4 sm:p-6 bg-white border-t border-gray-200 shadow-lg">
              <div className="max-w-2xl mx-auto grid grid-cols-[auto_1fr] gap-3">
                <button onClick={() => navigate("history")}
                  className="h-16 px-5 border-2 border-[#166534] text-[#166534] hover:bg-green-50 text-base font-semibold rounded-xl flex items-center justify-center gap-2">
                  <ClockIcon className="w-5 h-5" />
                  History
                </button>
                <button onClick={() => navigate("register")}
                  className="h-16 bg-[#166534] hover:bg-[#14532d] text-white text-lg font-semibold rounded-xl shadow-lg flex items-center justify-center gap-2">
                  Get My Queue Number
                  <ChevronRightIcon className="w-6 h-6" />
                </button>
              </div>
            </div>
            <div className="h-28" />
          </div>
        </div>
      )}

      {/* ════════════════ HISTORY PAGE ════════════════ */}
      {page === "history" && (
        <div className="min-h-screen bg-gradient-to-b from-green-50 to-white pb-12">
          <div className="bg-[#166534] text-white py-6 px-6 shadow-lg">
            <div className="flex items-center gap-3 max-w-2xl mx-auto">
              <button onClick={() => navigate("home")} className="text-white hover:bg-white/20 p-2 rounded-xl" aria-label="Back to home">
                <ArrowLeftIcon className="w-6 h-6" />
              </button>
              <div>
                <h1 className="text-2xl font-bold">Queue History</h1>
                <p className="text-green-200 text-sm">Queue numbers from your registrations on this device</p>
              </div>
            </div>
          </div>

          <div className="px-6 py-8 max-w-2xl mx-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Your Queue Numbers</h2>
            {historyEntries.length === 0 ? (
              <div className="bg-white rounded-2xl p-6 text-center text-gray-500 shadow-sm">
                No queue numbers yet. Your number will appear here after registration.
              </div>
            ) : (
              <div className="space-y-3">
                {historyEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => navigate("queue", entry.id)}
                  aria-label={`View queue registration for number ${entry.queueNumber}`}
                  className="w-full bg-white rounded-2xl p-5 shadow-sm border border-gray-100 text-left hover:border-green-300 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#166534]"
                >
                  <p className="text-xs font-semibold text-gray-500">QUEUE NUMBER</p>
                  <p className="text-3xl font-bold text-[#166534]">{entry.queueNumber}</p>
                  <p className="mt-2 text-sm font-semibold text-[#166534]">Tap to view registration</p>
                </button>
              ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════════════ REGISTER PAGE ════════════════ */}
      {page === "register" && (
        <div className="min-h-screen bg-gradient-to-b from-green-50 to-white pb-10">
          <div className="bg-[#166534] text-white py-6 px-6 shadow-lg">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate("home")} className="text-white hover:bg-white/20 p-2 rounded-xl">
                <ArrowLeftIcon className="w-6 h-6" />
              </button>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#4ade80] rounded-full flex items-center justify-center">
                  <PillIcon className="w-6 h-6 text-[#166534]" />
                </div>
                <div>
                  <h1 className="text-xl font-bold">Queue Registration</h1>
                  <p className="text-green-200 text-sm">Fill in your details</p>
                </div>
              </div>
            </div>
          </div>

          <div className="px-6 py-8 max-w-2xl mx-auto">
            <form onSubmit={handleSubmit} className="space-y-8">

              {/* Name */}
              <div className="space-y-2">
                <label className="text-base font-semibold text-gray-800">Full Name <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Enter your full name"
                  value={form.patientName}
                  onChange={(e) => setForm((p) => ({ ...p, patientName: e.target.value }))}
                  className="h-14 text-base rounded-xl border border-gray-300 w-full px-4 focus:outline-none focus:border-[#166534]" />
              </div>

              {/* Address */}
              <div className="space-y-2">
                <label className="text-base font-semibold text-gray-800">Address <span className="text-red-500">*</span></label>
                <input type="text" placeholder="Enter your complete address"
                  value={form.address}
                  onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  className="h-14 text-base rounded-xl border border-gray-300 w-full px-4 focus:outline-none focus:border-[#166534]" />
              </div>

              {/* Phone */}
              <div className="space-y-2">
                <label className="text-base font-semibold text-gray-800">
                  Phone Number <span className="text-red-500">*</span> <span className="text-gray-400 text-sm font-normal">(for SMS notifications)</span>
                </label>
                <input type="tel" inputMode="numeric" maxLength={11} pattern="09[0-9]{9}" required placeholder="e.g. 09123456789"
                  value={form.phone}
                  onChange={(e) => {
                    const phone = e.target.value;
                    setForm((p) => ({ ...p, phone }));
                    setOtpCode("");
                    setOtpSentFor(null);
                    setVerifiedPhone(null);
                  }}
                  className="h-14 text-base rounded-xl border border-gray-300 w-full px-4 focus:outline-none focus:border-[#166534]" />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={requestOtp}
                    disabled={isRequestingOtp || verifiedPhone === form.phone}
                    className="h-11 px-4 bg-[#166534] hover:bg-[#14532d] disabled:opacity-60 text-white rounded-lg font-semibold">
                    {verifiedPhone === form.phone ? "Phone verified" : isRequestingOtp ? "Sending..." : otpSentFor === form.phone ? "Resend code" : "Send verification code"}
                  </button>
                  {otpSentFor === form.phone && verifiedPhone !== form.phone && (
                    <>
                      <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                        aria-label="6-digit verification code" placeholder="6-digit code" value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                        className="h-11 w-36 px-3 rounded-lg border border-gray-300 focus:outline-none focus:border-[#166534]" />
                      <button type="button" onClick={verifyPhone} disabled={isVerifyingOtp || !/^\d{6}$/.test(otpCode)}
                        className="h-11 px-4 border border-[#166534] text-[#166534] disabled:opacity-50 rounded-lg font-semibold">
                        {isVerifyingOtp ? "Verifying..." : "Verify code"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Patient Type */}
              <div className="space-y-3">
                <label className="text-base font-semibold text-gray-800">Patient Type <span className="text-red-500">*</span></label>
                <div className="grid grid-cols-2 gap-4">
                  <button type="button" onClick={() => setForm((p) => ({ ...p, patientType: "regular" }))}
                    className={`flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 transition-all duration-200 min-h-[120px] ${
                      form.patientType === "regular"
                        ? "border-[#166534] bg-[#166534] text-white shadow-lg scale-105"
                        : "border-gray-200 bg-white text-gray-700 hover:border-green-400 hover:bg-green-50"
                    }`}>
                    <UserIcon className={`w-10 h-10 ${form.patientType === "regular" ? "text-[#4ade80]" : "text-gray-400"}`} />
                    <span className="font-bold text-base">Regular</span>
                    <span className={`text-xs text-center ${form.patientType === "regular" ? "text-green-200" : "text-gray-400"}`}>Standard queue</span>
                  </button>

                  <button type="button" onClick={() => setForm((p) => ({ ...p, patientType: "pwd" }))}
                    className={`flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 transition-all duration-200 min-h-[120px] ${
                      form.patientType === "pwd"
                        ? "border-blue-600 bg-blue-600 text-white shadow-lg scale-105"
                        : "border-gray-200 bg-white text-gray-700 hover:border-blue-500 hover:bg-blue-50"
                    }`}>
                    <AccessibilityIcon className={`w-10 h-10 ${form.patientType === "pwd" ? "text-blue-200" : "text-gray-400"}`} />
                    <span className="font-bold text-base">PWD</span>
                    <span className={`text-xs text-center ${form.patientType === "pwd" ? "text-blue-200" : "text-gray-400"}`}>Priority queue</span>
                  </button>
                </div>
                {form.patientType === "pwd" && (
                  <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
                    PWD patients are given priority in the queue. Please present your PWD ID at the counter.
                  </div>
                )}
              </div>

              {/* Medicine Selection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-base font-semibold text-gray-800">Medicine Needed <span className="text-red-500">*</span></label>
                  {form.selectedMedicines.length > 0 && (
                    <span className="text-sm text-[#166534] font-semibold bg-green-100 px-3 py-1 rounded-full">
                      {form.selectedMedicines.length} selected
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500">Tap a medicine to select and set quantity</p>
                <div className="flex gap-2">
                  <input
                    type="search"
                    value={neededSearchInput}
                    onChange={(e) => setNeededSearchInput(e.target.value)}
                    placeholder="Search by medicine name or type"
                    aria-label="Search medicine needed by name or type"
                    className="min-w-0 flex-1 h-11 px-4 rounded-xl border border-gray-300 focus:outline-none focus:border-[#166534]"
                  />
                  <button type="button" onClick={() => setNeededSearch(neededSearchInput)} className="h-11 px-4 bg-[#166534] hover:bg-[#14532d] text-white rounded-xl font-semibold flex items-center gap-2">
                    <SearchIcon className="w-4 h-4" /> Search
                  </button>
                </div>
                <div className="grid gap-3 max-h-72 overflow-y-auto pr-1">
                  {searchedNeededMeds.length === 0 ? (
                    <p className="text-gray-500 text-center py-4">{availableMeds.length === 0 ? "No medicines available" : "No medicines match your search"}</p>
                  ) : searchedNeededMeds.map((med) => {
                    const selected = form.selectedMedicines.find((m) => m.name === med.name);
                    const isSelected = !!selected;
                    const qty = selected?.quantity ?? 1;
                    return (
                      <div key={med.id}
                        onClick={() => toggleMedicine(med.name)}
                        className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all duration-150 ${
                          isSelected ? "border-[#166534] bg-green-50 shadow-sm" : "border-gray-200 bg-white hover:border-green-300 hover:bg-green-50/50"
                        }`}>
                        <div className="flex-shrink-0">
                          {isSelected
                            ? <CheckSquareIcon className="w-6 h-6 text-[#166534]" />
                            : <SquareIcon className="w-6 h-6 text-gray-300" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`font-semibold text-base ${isSelected ? "text-[#166534]" : "text-gray-800"}`}>{med.name}</p>
                          <p className="text-sm text-gray-500">{med.type}</p>
                        </div>
                        {isSelected && (
                          <div className="flex items-center gap-2 bg-white rounded-lg border border-gray-300 px-2"
                            onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => updateQty(med.name, qty - 1)}
                              className="p-2 text-gray-600 hover:text-[#166534] transition-colors">
                              <MinusIcon className="w-4 h-4" />
                            </button>
                            <span className="w-8 text-center font-semibold text-[#166534]">{qty}</span>
                            <button type="button" onClick={() => updateQty(med.name, qty + 1)}
                              className="p-2 text-gray-600 hover:text-[#166534] transition-colors">
                              <PlusIcon className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                        <span className="text-xs font-semibold px-3 py-1 bg-green-100 text-[#166534] rounded-full flex-shrink-0">
                          Quantity: {med.stock}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <button type="submit" disabled={isSubmitting || verifiedPhone !== form.phone}
                className="w-full h-16 bg-[#166534] hover:bg-[#14532d] disabled:opacity-60 text-white text-lg font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                <PillIcon className="w-6 h-6" />
                {isSubmitting ? "Generating..." : "Get My Queue Number"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ════════════════ QUEUE NUMBER PAGE ════════════════ */}
      {page === "queue" && currentEntry && (
        <div className="min-h-screen bg-gradient-to-b from-green-50 to-white">
          {/* Header */}
          <div className={`text-white py-6 px-6 shadow-lg ${currentEntry.patientType === "pwd" ? "bg-blue-700" : "bg-[#166534]"}`}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${currentEntry.patientType === "pwd" ? "bg-blue-300" : "bg-[#4ade80]"}`}>
                {currentEntry.patientType === "pwd"
                  ? <AccessibilityIcon className="w-6 h-6 text-blue-700" />
                  : <PillIcon className="w-6 h-6 text-[#166534]" />}
              </div>
              <div>
                <h1 className="text-xl font-bold">Your Queue Number</h1>
                <p className={`text-sm ${currentEntry.patientType === "pwd" ? "text-blue-200" : "text-green-200"}`}>
                  {currentEntry.patientType === "pwd" ? "Priority Queue — PWD Patient" : "Please wait for your turn"}
                </p>
              </div>
            </div>
          </div>

          <div className="px-6 py-8 max-w-2xl mx-auto">
            {/* Queue Card */}
            <div className={`rounded-3xl overflow-hidden shadow-2xl mb-6 ${currentEntry.patientType === "pwd" ? "bg-gradient-to-br from-blue-700 to-blue-900" : "bg-gradient-to-br from-[#166534] to-[#14532d]"}`}>
              <div className="px-6 pt-6 flex justify-end">
                <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold ${currentEntry.patientType === "pwd" ? "bg-blue-300 text-blue-900" : "bg-[#4ade80] text-[#166534]"}`}>
                  {currentEntry.patientType === "pwd" ? "PWD Priority" : "Regular"}
                </span>
              </div>
              <div className="text-center px-6 pt-4 pb-6">
                <p className={`mb-2 text-sm font-medium ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-green-300"}`}>Queue Number</p>
                <div className={`text-8xl font-black mb-3 tracking-tight ${currentEntry.patientType === "pwd" ? "text-blue-200" : "text-[#4ade80]"}`}>
                  {currentEntry.queueNumber}
                </div>
                <div className={`w-24 h-1.5 mx-auto rounded-full ${currentEntry.patientType === "pwd" ? "bg-blue-400" : "bg-[#4ade80]"}`} />
              </div>
              <div className="px-6 pb-8 space-y-4 text-white">
                <InfoRow icon={<UserIcon className={`w-5 h-5 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-[#4ade80]"}`} />}
                  label="Patient Name" labelColor={currentEntry.patientType === "pwd" ? "text-blue-300" : "text-green-300"}
                  value={currentEntry.patientName} />
                <InfoRow icon={<MapPinIcon className={`w-5 h-5 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-[#4ade80]"}`} />}
                  label="Address" labelColor={currentEntry.patientType === "pwd" ? "text-blue-300" : "text-green-300"}
                  value={currentEntry.address} />

                <div className="flex items-start gap-3">
                  <PackageIcon className={`w-5 h-5 flex-shrink-0 mt-1 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-[#4ade80]"}`} />
                  <div className="flex-1">
                    <p className={`text-xs mb-2 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-green-300"}`}>
                      Medicine(s) — Qty: {currentEntry.quantities.reduce((a, b) => a + b, 0)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {currentEntry.medicines.map((m, i) => (
                        <span key={i} className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${currentEntry.patientType === "pwd" ? "bg-blue-500/40 text-blue-100" : "bg-white/20 text-white"}`}>
                          {m} (×{currentEntry.quantities[i] ?? 1})
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 pt-4 border-t border-white/20">
                  <div className="flex items-center gap-2">
                    <CalendarIcon className={`w-4 h-4 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-[#4ade80]"}`} />
                    <span className="text-sm text-white/80">
                      {new Date(currentEntry.timestamp).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ClockIcon className={`w-4 h-4 ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-[#4ade80]"}`} />
                  <span className="text-sm text-white/80">
                    {new Date(currentEntry.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <button onClick={saveToPhone}
                className="h-14 border-2 border-[#166534] text-[#166534] hover:bg-[#166534] hover:text-white rounded-xl flex items-center justify-center font-medium">
                <DownloadIcon className="w-5 h-5 mr-2" /> Save to Phone
              </button>
              <button onClick={() => navigate("register")}
                className="h-14 border-2 border-gray-300 text-gray-700 hover:border-[#166534] hover:text-[#166534] rounded-xl flex items-center justify-center font-medium">
                <RotateCcwIcon className="w-5 h-5 mr-2" /> Register Again
              </button>
            </div>

            <button onClick={() => navigate("track", currentEntry.id)}
              className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl flex items-center justify-center mb-4">
              <ClockIcon className="w-5 h-5 mr-2" /> Track My Queue Status
            </button>

            {/* What's Next */}
            <div className={`rounded-xl p-5 mb-6 ${currentEntry.patientType === "pwd" ? "bg-blue-50 border border-blue-200" : "bg-green-50 border border-green-200"}`}>
              <h3 className={`font-bold mb-3 ${currentEntry.patientType === "pwd" ? "text-blue-900" : "text-[#166534]"}`}>What&apos;s Next?</h3>
              <ul className="space-y-2 text-sm">
                {currentEntry.patientType === "pwd" && (
                  <li className="flex gap-2 text-blue-800"><span className="text-blue-500 font-bold">★</span><span>As a PWD patient, you have priority — you will be called ahead of regular patients.</span></li>
                )}
                <li className={`flex gap-2 ${currentEntry.patientType === "pwd" ? "text-blue-800" : "text-green-800"}`}><span>•</span><span>Please wait in the designated waiting area</span></li>
                <li className={`flex gap-2 ${currentEntry.patientType === "pwd" ? "text-blue-800" : "text-green-800"}`}><span>•</span><span>Your queue number will be called when it&apos;s your turn</span></li>
                <li className={`flex gap-2 ${currentEntry.patientType === "pwd" ? "text-blue-800" : "text-green-800"}`}><span>•</span><span>Have your prescription ready to present at the counter</span></li>
                {currentEntry.phone && (
                  <li className={`flex gap-2 ${currentEntry.patientType === "pwd" ? "text-blue-800" : "text-green-800"}`}><span>•</span><span>You will receive an SMS notification when your medicine is ready.</span></li>
                )}
              </ul>
            </div>

            <button onClick={() => navigate("home")}
              className="w-full h-14 bg-[#166534] hover:bg-[#14532d] text-white font-semibold rounded-xl flex items-center justify-center">
              <HomeIcon className="w-5 h-5 mr-2" /> Back to Home
            </button>
          </div>
        </div>
      )}

      {/* ════════════════ TRACK PAGE ════════════════ */}
      {page === "track" && currentEntry && (
        <div className="min-h-screen bg-gradient-to-b from-green-50 to-white pb-12">
          <div className="bg-[#166534] text-white py-6 px-6 shadow-lg">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate("queue", currentEntry.id)} className="text-white hover:bg-white/20 p-2 rounded-xl" aria-label="Back to your queue number">
                <ArrowLeftIcon className="w-6 h-6" />
              </button>
              <div>
                <h1 className="text-2xl font-bold">Track My Queue</h1>
                <p className="text-green-200 text-sm">Real-time updates</p>
              </div>
            </div>
          </div>

          <div className="px-6 pt-8 max-w-2xl mx-auto">
            <div className="text-center mb-10">
              <p className="text-gray-500 text-sm font-medium">YOUR QUEUE NUMBER</p>
              <p className="text-7xl font-bold text-[#166534] tracking-tighter mt-2">{currentEntry.queueNumber}</p>
              {currentEntry.patientType === "pwd" && (
                <span className="inline-block mt-3 px-5 py-1 bg-blue-100 text-blue-700 text-sm font-semibold rounded-full">PWD – PRIORITY</span>
              )}
            </div>

            {/* Status Steps */}
            <div className="bg-white rounded-3xl p-8 mb-8 shadow-sm border border-gray-200">
              <div className="flex justify-between relative mb-10">
                {STATUS_STEPS.map((step, i) => {
                  const currentIndex = STATUS_STEPS.findIndex((s) => s.key === currentEntry.status);
                  const active = i <= currentIndex;
                  return (
                    <div key={step.key} className="flex flex-col items-center relative z-10">
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-xl transition-all duration-500 ${active ? "bg-[#166534] scale-110 shadow-lg" : "bg-gray-200 text-gray-400"}`}>
                        {i + 1}
                      </div>
                      <p className={`text-xs font-semibold mt-3 ${active ? "text-[#166534]" : "text-gray-400"}`}>{step.label}</p>
                    </div>
                  );
                })}
                {/* Progress line */}
                <div className="absolute top-6 left-0 h-1 bg-gray-200 w-full -z-10">
                  <div className="h-1 bg-[#166534] transition-all duration-700"
                    style={{ width: `${(STATUS_STEPS.findIndex((s) => s.key === currentEntry.status) / (STATUS_STEPS.length - 1)) * 100}%` }} />
                </div>
              </div>

              {/* Status Message */}
              <div className={`text-center p-8 rounded-2xl text-lg font-semibold leading-relaxed ${
                currentEntry.status === "getready" ? "bg-amber-100 text-amber-700 border-2 border-amber-400" :
                currentEntry.status === "served"   ? "bg-green-100 text-green-700" :
                currentEntry.status === "processing" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700"
              }`}>
                {currentEntry.status === "waiting"    && "Please wait. Your turn is coming soon."}
                {currentEntry.status === "processing" && "Your medicine is now being prepared by our staff."}
                {currentEntry.status === "getready"   && "🎉 YOUR MEDICINE IS READY! Please proceed to the counter now."}
                {currentEntry.status === "served"     && "Thank you! You have been served."}
              </div>
            </div>

            {/* Your Info */}
            <div className="bg-white rounded-3xl p-6 mb-8 shadow-sm">
              <h3 className="font-semibold text-gray-700 mb-4">Your Information</h3>
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-gray-500">Patient Name</p>
                  <p className="font-semibold text-lg">{currentEntry.patientName}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Medicines Requested</p>
                  <div className="mt-2 space-y-2">
                    {currentEntry.medicines.map((med, i) => (
                      <div key={i} className="flex justify-between bg-green-50 px-4 py-3 rounded-xl">
                        <span className="text-gray-700">{med}</span>
                        <span className="font-bold text-[#166534]">× {currentEntry.quantities[i] ?? 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500 pt-2 border-t">
                  <ClockIcon className="w-4 h-4" />
                  <span>Registered at {new Date(currentEntry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <button onClick={refreshStatus}
                className="h-14 bg-[#166534] hover:bg-[#14532d] text-white text-base font-semibold rounded-2xl flex items-center justify-center">
                <RefreshCwIcon className={`mr-2 w-5 h-5 ${isRefreshing ? "animate-spin" : ""}`} /> Refresh Status
              </button>
              {currentEntry.status === "getready" && (
                <button onClick={() => navigate("home")}
                  className="h-14 bg-green-600 hover:bg-green-700 text-white text-base font-semibold rounded-2xl flex items-center justify-center">
                  <CheckCircleIcon className="mr-2 w-5 h-5" /> I Have Been Served
                </button>
              )}
              <button onClick={() => navigate("home")} className="text-gray-500 hover:text-gray-700 py-3 text-sm font-medium">
                Back to Home
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fallback if entry not found */}
      {(page === "queue" || page === "track") && !currentEntry && (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
          <p className="text-gray-500 text-lg">Entry not found. Please register again.</p>
          <button onClick={() => navigate("home")} className="px-6 py-3 bg-[#166534] text-white rounded-xl font-semibold">
            Back to Home
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Small helper: InfoRow ────────────────────────────────────────────────────
function InfoRow({ icon, label, labelColor, value }: { icon: React.ReactNode; label: string; labelColor: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div>
        <p className={`text-xs mb-0.5 ${labelColor}`}>{label}</p>
        <p className="font-semibold text-base text-white">{value}</p>
      </div>
    </div>
  );
}

// ─── Inline SVG Icons ─────────────────────────────────────────────────────────
function PillIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>
    </svg>
  );
}
function UserIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
    </svg>
  );
}
function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}
function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>
    </svg>
  );
}
function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6"/>
    </svg>
  );
}
function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>
    </svg>
  );
}
function AccessibilityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-5.87.94"/><path d="M5 8l3-3 4 2 2 4-3 3"/><path d="m11.5 17.5-2 2.5H5"/><path d="m14 13.5 2.5 4.5H20"/>
    </svg>
  );
}
function CheckSquareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  );
}
function SquareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
    </svg>
  );
}
function MinusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}
function MapPinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
    </svg>
  );
}
function PackageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>
    </svg>
  );
}
function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}
function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}
function RotateCcwIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
    </svg>
  );
}
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}
function RefreshCwIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>
    </svg>
  );
}
function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}
