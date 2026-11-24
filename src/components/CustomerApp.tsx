"use client";

import { useEffect, useState, useCallback } from "react";
import {
  subscribeStockItems,
  subscribeQueueEntries,
  addQueueEntry,
  getNextQueueNumber,
  getStockItems,
  isStockItemAvailable,
  updateQueueEntryStatus,
  getQueueEntry,
  isGetReadyExpired,
  getReadyRemainingMs,
  type StockItem,
  type QueueEntry,
} from "@/lib/firestore";

function formatRemainingTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
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

const LOW_STOCK_THRESHOLD = 100;

function isLowStock(stock: number): boolean {
  return stock <= LOW_STOCK_THRESHOLD;
}

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
  const [extraHistoryEntries, setExtraHistoryEntries] = useState<Map<string, QueueEntry>>(new Map());
  const [queueNoticeModal, setQueueNoticeModal] = useState<QueueEntry | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isMarkingServed, setIsMarkingServed] = useState(false);
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

  useEffect(() => {
    const timer = setInterval(() => setCurrentTimeMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch any history entry not in today's realtime entries
  useEffect(() => {
    let isMounted = true;
    const missingIds = historyEntryIds.filter(
      (id) => !entries.some((e) => e.id === id) && !extraHistoryEntries.has(id)
    );
    if (missingIds.length === 0) return;

    Promise.all(missingIds.map((id) => getQueueEntry(id))).then((results) => {
      if (!isMounted) return;
      setExtraHistoryEntries((prev) => {
        const next = new Map(prev);
        results.forEach((entry) => {
          if (entry) next.set(entry.id, entry);
        });
        return next;
      });
    });

    return () => {
      isMounted = false;
    };
  }, [historyEntryIds, entries, extraHistoryEntries]);

  // Auto-archive expired getready entries
  useEffect(() => {
    const checkExpired = async () => {
      const now = Date.now();
      const expired = entries.find(
        (e) => e.status === "getready" && isGetReadyExpired(e, now)
      );
      if (expired) {
        try {
          await updateQueueEntryStatus(expired.id, "archived", {
            archivedReason: "no_show",
          });
        } catch {
          // ignore
        }
      }
    };
    checkExpired();
    const interval = setInterval(checkExpired, 4000);
    return () => clearInterval(interval);
  }, [entries]);

  // Subscribe to Firestore in real-time
  useEffect(() => {
    const unsubStock  = subscribeStockItems(setMedicines);
    const unsubQueue  = subscribeQueueEntries(setEntries);
    return () => { unsubStock(); unsubQueue(); };
  }, []);

  useEffect(() => {
    setForm((prev) => {
      let changed = false;
      const selectedMedicines = prev.selectedMedicines.flatMap((selected) => {
        const medicine = medicines.find((item) => item.name === selected.name);
        if (!medicine || !isStockItemAvailable(medicine)) {
          changed = true;
          return [];
        }
        const quantity = Math.min(selected.quantity, medicine.stock);
        if (quantity !== selected.quantity) changed = true;
        return [{ ...selected, quantity }];
      });
      return changed ? { ...prev, selectedMedicines } : prev;
    });
  }, [medicines]);

  const historyEntries = historyEntryIds
    .map((id) => entries.find((e) => e.id === id) ?? extraHistoryEntries.get(id))
    .filter((e): e is QueueEntry => !!e);
  const currentEntry =
    (currentId ? entries.find((e) => e.id === currentId) ?? extraHistoryEntries.get(currentId) : null) ?? null;

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
    const latestStockItems = await getStockItems();
    const unavailableMedicine = form.selectedMedicines.find((selected) => {
      const medicine = latestStockItems.find((item) => item.name === selected.name);
      return (
        !medicine ||
        !isStockItemAvailable(medicine) ||
        selected.quantity > medicine.stock
      );
    });
    if (unavailableMedicine) {
      const latestMedicine = latestStockItems.find(
        (item) => item.name === unavailableMedicine.name
      );
      showToast(
        !latestMedicine || !isStockItemAvailable(latestMedicine)
          ? `${unavailableMedicine.name} is no longer available. Please update your selection.`
          : `Only ${latestMedicine.stock} ${unavailableMedicine.name} remaining. Please update your quantity.`,
        "error"
      );
      return;
    }

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
  } finally {
    setIsSubmitting(false);
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
    const medicine = medicines.find((item) => item.name === name);
    const exists = form.selectedMedicines.some((item) => item.name === name);
    if (!exists && (!medicine || !isStockItemAvailable(medicine))) {
      showToast(`${name} is unavailable`, "error");
      return;
    }

    setForm((prev) => {
      return {
        ...prev,
        selectedMedicines: prev.selectedMedicines.some((m) => m.name === name)
          ? prev.selectedMedicines.filter((m) => m.name !== name)
          : [...prev.selectedMedicines, { name, quantity: 1 }],
      };
    });
  }

  function updateQty(name: string, qty: number, showLimitWarning = false) {
    const medicine = medicines.find((item) => item.name === name);
    if (!medicine || !isStockItemAvailable(medicine)) {
      showToast(`${name} is unavailable`, "error");
      return;
    }
    const availableStock = medicine.stock;
    if (!Number.isFinite(qty)) return;
    if (qty > availableStock) {
      if (showLimitWarning) showToast(`Cannot exceed available stock: ${availableStock}`, "error");
      qty = availableStock;
    }
    if (qty < 1) return;

    setForm((prev) => ({
      ...prev,
      selectedMedicines: prev.selectedMedicines.map((medicine) =>
        medicine.name === name ? { ...medicine, quantity: Math.min(qty, availableStock) } : medicine
      ),
    }));
  }

  // ─── Tracking helpers ──────────────────────────────────────────────────────
  function refreshStatus() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 600);
  }

  async function handleMarkServed() {
    if (!currentEntry || isMarkingServed) return;
    if (currentEntry.status !== "getready") return;

    setIsMarkingServed(true);
    try {
      await updateQueueEntryStatus(currentEntry.id, "served");
      showToast("Status updated to Served");
    } catch (error) {
      console.error("Could not mark queue entry as served:", error);
      showToast("Could not update the status. Please try again.", "error");
    } finally {
      setIsMarkingServed(false);
    }
  }

  // ─── Save queue details as an image ────────────────────────────────────────
  async function saveToPhone() {
    if (!currentEntry) return;
    const totalQty = currentEntry.quantities.reduce((a, b) => a + b, 0);
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 760;
    const context = canvas.getContext("2d");
    if (!context) {
      showToast("Could not create the queue image. Please try again.", "error");
      return;
    }

    context.fillStyle = currentEntry.patientType === "pwd" ? "#1d4ed8" : "#166534";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.font = "bold 34px sans-serif";
    context.fillText("MediServe - City Health Pharmacy", canvas.width / 2, 70);
    context.font = currentEntry.queueNumber.length > 4 ? "bold 110px sans-serif" : "bold 150px sans-serif";
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

    try {
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];
      if (!base64) throw new Error("The queue image could not be created.");
      const binary = window.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: "image/png" });

      const fileName = `queue-${currentEntry.queueNumber}.png`;
      if (typeof File !== "undefined" && typeof navigator.share === "function") {
        const file = new File([blob], fileName, { type: "image/png" });
        const shareData: ShareData = { files: [file], title: "MediServe queue details" };
        if (!navigator.canShare || navigator.canShare(shareData)) {
          try {
            const shareResult = navigator.share(shareData);
            await shareResult;
            showToast("Image ready to save. Choose Save Image or Save to Files.");
            return;
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            console.error("Could not share queue image:", error);
          }
        }
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Image download started. Check your Downloads or Photos.");
    } catch (error) {
      console.error("Could not save queue image:", error);
      showToast("Could not save the queue image. Please try again.", "error");
    }
  }

  const customerMeds = medicines;
  const searchedAvailableMeds = customerMeds.filter((med) => {
    const query = availableSearch.trim().toLowerCase();
    return !query || med.name.toLowerCase().includes(query) || med.type.toLowerCase().includes(query);
  });
  const searchedNeededMeds = customerMeds.filter((med) => {
    const query = neededSearch.trim().toLowerCase();
    return !query || med.name.toLowerCase().includes(query) || med.type.toLowerCase().includes(query);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="customer-app h-dvh overflow-hidden bg-gray-50">

      {/* ── Toast Stack ── */}
      <div className="fixed top-4 sm:top-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id}
            className={`toast w-full px-4 sm:px-6 py-3 rounded-2xl shadow-xl text-white text-center font-medium pointer-events-auto ${
              t.type === "error" ? "bg-red-500" : "bg-[#166534]"
            }`}>{t.msg}</div>
        ))}
      </div>

      {/* ════════════════ HOME PAGE ════════════════ */}
      {page === "home" && (
        <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-green-50 to-white">
          {/* Header */}
          <div className="shrink-0 bg-[#166534] text-white py-3 sm:py-5 px-4 sm:px-6 shadow-lg">
            <div className="flex items-center justify-between max-w-2xl md:max-w-4xl lg:max-w-5xl mx-auto">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 sm:w-12 sm:h-12 bg-[#4ade80] rounded-full flex items-center justify-center flex-shrink-0">
                  <PillIcon className="w-6 h-6 sm:w-7 sm:h-7 text-[#166534]" />
                </div>
                <div>
                  <h1 className="text-xl sm:text-2xl font-bold">MediServe</h1>
                  <p className="text-green-200 text-xs sm:text-sm">City Health Pharmacy</p>
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 sm:px-6 py-5 sm:py-6 max-w-2xl md:max-w-4xl lg:max-w-5xl mx-auto">
            <div className="mb-6 sm:mb-8 slide-up" style={{ animationDelay: "0.1s" }}>
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Welcome</h2>
              <p className="text-sm sm:text-base text-gray-600">Get your queue number and wait comfortably for your turn</p>
            </div>

            <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-lg mb-6 sm:mb-8 slide-up" style={{ animationDelay: "0.2s" }}>
              <div className="flex gap-3">
                <AlertIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-900 mb-1">Important Notice</p>
                  <p className="text-sm text-amber-800">Please present your doctor&apos;s prescription to the counter for proper medicine dispensing.</p>
                </div>
              </div>
            </div>

            <div className="mb-6 sm:mb-8 slide-up" style={{ animationDelay: "0.3s" }}>
              <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-4">Medicines &amp; Availability</h3>
              <form onSubmit={(e) => { e.preventDefault(); setAvailableSearch(availableSearchInput); }} className="flex flex-col min-[420px]:flex-row gap-2 mb-4">
                <input
                  type="search"
                  value={availableSearchInput}
                  onChange={(e) => setAvailableSearchInput(e.target.value)}
                  placeholder="Search by medicine name or type"
                  aria-label="Search medicines by name or type"
                  className="min-w-0 flex-1 h-11 px-4 rounded-xl border border-gray-300 focus:outline-none focus:border-[#166534]"
                />
                <button type="submit" className="h-11 w-full min-[420px]:w-auto px-4 bg-[#166534] hover:bg-[#14532d] text-white rounded-xl font-semibold flex items-center justify-center gap-2">
                  <SearchIcon className="w-4 h-4" /> Search
                </button>
              </form>
              <div className="grid max-h-[55vh] sm:max-h-96 gap-3 overflow-y-auto pr-1 overscroll-contain md:grid-cols-2">
                {searchedAvailableMeds.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">{customerMeds.length === 0 ? "No medicines in inventory" : "No medicines match your search"}</p>
                ) : searchedAvailableMeds.map((med, i) => (
                  <div key={med.id} className="slide-in-left" style={{ animationDelay: `${0.4 + i * 0.05}s` }}>
                    <div className={`bg-white border-l-4 p-3 sm:p-4 rounded-xl transition-shadow ${
                      isStockItemAvailable(med)
                        ? "border-l-[#4ade80] hover:shadow-md"
                        : "border-l-gray-400 opacity-70"
                    }`}>
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                            <PillIcon className="w-5 h-5 text-[#166534]" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 break-words">{med.name}</p>
                            <p className="text-sm text-gray-500 break-words">{med.type}</p>
                          </div>
                        </div>
                        <span className={`inline-block px-2 sm:px-3 py-1 rounded text-[10px] sm:text-xs font-semibold whitespace-nowrap ${
                          isStockItemAvailable(med) ? "bg-green-100 text-[#166534]" : "bg-gray-100 text-gray-600"
                        }`}>
                          Quantity: {med.stock}
                        </span>
                      </div>
                      <span
                        className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-bold ${
                          !isStockItemAvailable(med)
                            ? "bg-gray-100 text-gray-700"
                            : isLowStock(med.stock)
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}
                        aria-label={`${med.name} availability: ${
                          !isStockItemAvailable(med)
                            ? med.stock <= 0 ? "Out of Stock" : "Unavailable"
                            : isLowStock(med.stock) ? "Low Stock" : "In Stock"
                        }`}
                      >
                        {!isStockItemAvailable(med)
                          ? med.stock <= 0 ? "Out of Stock" : "Unavailable"
                          : isLowStock(med.stock) ? "Low Stock" : "In Stock"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
          </div>

          <div className="customer-app-footer shrink-0 border-t border-gray-200 bg-white px-4 py-2 sm:px-6 sm:py-3 shadow-lg">
              <div className="max-w-2xl md:max-w-4xl lg:max-w-5xl mx-auto grid grid-cols-[auto_1fr] gap-3">
                <button onClick={() => navigate("history")}
                  className="h-12 px-3 sm:px-5 border-2 border-[#166534] text-[#166534] hover:bg-green-50 text-sm sm:text-base font-semibold rounded-xl flex items-center justify-center gap-2">
                  <ClockIcon className="w-5 h-5" />
                  History
                </button>
                <button onClick={() => navigate("register")}
                  className="h-12 px-2 bg-[#166534] hover:bg-[#14532d] text-white text-base sm:text-lg font-semibold rounded-xl shadow-lg flex items-center justify-center gap-2">
                  Get My Queue Number
                  <ChevronRightIcon className="w-6 h-6" />
                </button>
              </div>
          </div>
        </div>
      )}

      {/* ════════════════ HISTORY PAGE ════════════════ */}
      {page === "history" && (
        <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-green-50 to-white">
          <div className="shrink-0 bg-[#166534] text-white py-4 sm:py-5 px-4 sm:px-6 shadow-lg">
            <div className="flex items-center gap-3 max-w-2xl md:max-w-4xl mx-auto">
              <button onClick={() => navigate("home")} className="text-white hover:bg-white/20 p-2 rounded-xl" aria-label="Back to home">
                <ArrowLeftIcon className="w-6 h-6" />
              </button>
              <div>
                <h1 className="text-2xl font-bold">Queue History</h1>
                <p className="text-green-200 text-sm">Queue numbers from your registrations on this device</p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 sm:px-6 py-8 max-w-2xl md:max-w-4xl mx-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Your Queue Numbers</h2>
            {historyEntries.length === 0 ? (
              <div className="bg-white rounded-2xl p-6 text-center text-gray-500 shadow-sm">
                No queue numbers yet. Your number will appear here after registration.
              </div>
            ) : (
              <div className="space-y-3">
                {historyEntries.map((entry) => {
                  const isExpired = isGetReadyExpired(entry, currentTimeMs);
                  const isArchived = entry.status === "archived" || isExpired;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        if (isArchived) {
                          setQueueNoticeModal(entry);
                        } else {
                          navigate("queue", entry.id);
                        }
                      }}
                      aria-label={`View queue registration for number ${entry.queueNumber}`}
                      className={`w-full bg-white rounded-2xl p-5 shadow-sm border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#166534] ${
                        isArchived
                          ? "border-amber-300 hover:border-amber-400 hover:shadow-md bg-amber-50/20"
                          : "border-gray-100 hover:border-green-300 hover:shadow-md"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold text-gray-500">QUEUE NUMBER</p>
                          <p className={`text-3xl font-black ${isArchived ? "text-amber-800" : "text-[#166534]"}`}>
                            {entry.queueNumber}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className={`inline-block px-3 py-1 text-xs font-bold rounded-full ${
                            isArchived
                              ? "bg-amber-100 text-amber-800 border border-amber-300"
                              : entry.status === "served"
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                                : entry.status === "getready"
                                  ? "bg-orange-100 text-orange-800 border border-orange-300"
                                  : entry.status === "processing"
                                    ? "bg-blue-100 text-blue-800 border border-blue-200"
                                    : "bg-gray-100 text-gray-700 border border-gray-200"
                          }`}>
                            {isArchived
                              ? "Archived"
                              : entry.status === "getready"
                                ? "Get Ready"
                                : entry.status === "processing"
                                  ? "Processing"
                                  : entry.status === "served"
                                    ? "Served"
                                    : "Waiting"}
                          </span>
                          {entry.status === "getready" && !isArchived && (
                            <p className="text-xs font-semibold text-orange-600 mt-1">
                              ⏱ {formatRemainingTime(getReadyRemainingMs(entry, currentTimeMs))} left
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                        <span>{entry.patientName}</span>
                        <span>
                          {new Date(entry.timestamp).toLocaleDateString([], {
                            month: "short",
                            day: "numeric",
                          })}{" "}
                          ·{" "}
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>

                      {isArchived ? (
                        <div className="mt-2 text-sm font-bold text-amber-700 flex items-center gap-1.5">
                          <AlertIcon className="w-4 h-4 text-amber-600 shrink-0" />
                          <span>Tap to view notice: Get Queue Again</span>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm font-semibold text-[#166534]">
                          Tap to view registration &rarr;
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          </div>

          <div className="customer-app-footer shrink-0 border-t border-gray-200 bg-white px-4 py-2 sm:px-6 sm:py-3">
            <div className="max-w-2xl md:max-w-4xl mx-auto">
              <button onClick={() => navigate("home")}
                className="h-12 w-full rounded-xl border-2 border-[#166534] font-semibold text-[#166534] hover:bg-green-50">
                Back to Home
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════ REGISTER PAGE ════════════════ */}
      {page === "register" && (
        <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-green-50 to-white">
          <div className="shrink-0 bg-[#166534] text-white py-4 sm:py-5 px-4 sm:px-6 shadow-lg">
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

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 sm:px-6 py-8 max-w-2xl md:max-w-3xl mx-auto">
            <form id="queue-registration-form" onSubmit={handleSubmit} className="space-y-8">

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
                <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-4">
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
                    <span className="font-bold text-base">PWD / Senior Citizen / Pregnant</span>
                    <span className={`text-xs text-center ${form.patientType === "pwd" ? "text-blue-200" : "text-gray-400"}`}>Priority queue</span>
                  </button>
                </div>
                {form.patientType === "pwd" && (
                  <div className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
                    PWD, Senior Citizen, and Pregnant patients are given priority in the queue. Please present your ID at the counter.
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
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="search"
                    value={neededSearchInput}
                    onChange={(e) => setNeededSearchInput(e.target.value)}
                    placeholder="Search by medicine name or type"
                    aria-label="Search medicine needed by name or type"
                    className="min-w-0 flex-1 h-11 px-4 rounded-xl border border-gray-300 focus:outline-none focus:border-[#166534]"
                  />
                  <button type="button" onClick={() => setNeededSearch(neededSearchInput)} className="h-11 px-4 bg-[#166534] hover:bg-[#14532d] text-white rounded-xl font-semibold flex items-center justify-center gap-2">
                    <SearchIcon className="w-4 h-4" /> Search
                  </button>
                </div>
                <div className="grid max-h-[55vh] sm:max-h-96 gap-3 overflow-y-auto pr-1 overscroll-contain">
                  {searchedNeededMeds.length === 0 ? (
                    <p className="text-gray-500 text-center py-4">{customerMeds.length === 0 ? "No medicines in inventory" : "No medicines match your search"}</p>
                  ) : searchedNeededMeds.map((med) => {
                    const selected = form.selectedMedicines.find((m) => m.name === med.name);
                    const isSelected = !!selected;
                    const medicineAvailable = isStockItemAvailable(med);
                    const availabilityLabel = medicineAvailable
                      ? isLowStock(med.stock) ? "Low Stock" : "In Stock"
                      : med.stock <= 0 ? "Out of Stock" : "Unavailable";
                    const availabilityClass = medicineAvailable
                      ? isLowStock(med.stock)
                        ? "bg-red-100 text-red-700"
                        : "bg-green-100 text-[#166534]"
                      : "bg-gray-100 text-gray-700";
                    const qty = selected?.quantity ?? 1;
                    return (
                      <div key={med.id}
                        role="button"
                        aria-disabled={!medicineAvailable}
                        tabIndex={medicineAvailable ? 0 : -1}
                        onClick={() => medicineAvailable && toggleMedicine(med.name)}
                        onKeyDown={(event) => {
                          if (medicineAvailable && (event.key === "Enter" || event.key === " ")) {
                            event.preventDefault();
                            toggleMedicine(med.name);
                          }
                        }}
                        className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 sm:p-4 rounded-xl border-2 transition-all duration-150 ${
                          !medicineAvailable
                            ? "border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed"
                            : isSelected
                              ? "border-[#166534] bg-green-50 shadow-sm cursor-pointer"
                              : "border-gray-200 bg-white hover:border-green-300 hover:bg-green-50/50 cursor-pointer"
                        }`}>
                        <div className="flex items-start gap-3 min-w-0 w-full sm:flex-1">
                          <div className="flex-shrink-0 mt-0.5">
                            {isSelected
                              ? <CheckSquareIcon className="w-6 h-6 text-[#166534]" />
                              : <SquareIcon className="w-6 h-6 text-gray-300" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`font-semibold text-base break-words ${isSelected ? "text-[#166534]" : "text-gray-800"}`}>{med.name}</p>
                            <p className="text-sm text-gray-500 break-words">{med.type}</p>
                          </div>
                          <div className="flex sm:hidden flex-col items-end gap-1 flex-shrink-0">
                            <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${availabilityClass}`}>
                              Qty: {med.stock}
                            </span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${availabilityClass}`}>
                              {availabilityLabel}
                            </span>
                          </div>
                        </div>
                        {isSelected && medicineAvailable && (
                          <div className="flex items-center justify-between sm:justify-start gap-2 bg-white rounded-lg border border-gray-300 px-2 w-full sm:w-auto"
                            onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => updateQty(med.name, qty - 1)}
                              className="p-2 flex-shrink-0 text-gray-600 hover:text-[#166534] transition-colors">
                              <MinusIcon className="w-4 h-4" />
                            </button>
                            <input
                              type="number"
                              min={1}
                              max={med.stock}
                              value={qty}
                              onChange={(e) => updateQty(med.name, Number(e.target.value), Number(e.target.value) > med.stock)}
                              aria-label={`Quantity for ${med.name}`}
                              className="w-12 sm:w-14 text-center font-semibold text-[#166534] border-0 outline-none bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            <button type="button" onClick={() => updateQty(med.name, qty + 1, true)}
                              disabled={!medicineAvailable || qty >= med.stock}
                              aria-label={`Increase quantity for ${med.name}`}
                              className="p-2 flex-shrink-0 text-gray-600 hover:text-[#166534] disabled:text-gray-300 disabled:cursor-not-allowed transition-colors">
                              <PlusIcon className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                        <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0">
                          <span className={`text-xs font-semibold px-3 py-1 rounded-full ${availabilityClass}`}>
                            Quantity: {med.stock}
                          </span>
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${availabilityClass}`}>
                            {availabilityLabel}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </form>
          </div>
          </div>

          <div className="customer-app-footer shrink-0 border-t border-gray-200 bg-white px-4 py-2 sm:px-6 sm:py-3 shadow-lg">
            <div className="max-w-2xl md:max-w-3xl mx-auto">
              <button type="submit" form="queue-registration-form" disabled={isSubmitting || verifiedPhone !== form.phone}
                className="w-full h-12 sm:h-14 bg-[#166534] hover:bg-[#14532d] disabled:cursor-not-allowed disabled:opacity-60 text-white text-base sm:text-lg font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                <PillIcon className="w-6 h-6" />
                {isSubmitting ? "Generating..." : "Get My Queue Number"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════ QUEUE NUMBER PAGE ════════════════ */}
      {page === "queue" && currentEntry && (() => {
        const isCurrentExpired = isGetReadyExpired(currentEntry, currentTimeMs);
        const isCurrentArchived = currentEntry.status === "archived" || isCurrentExpired;
        return (
        <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-green-50 to-white">
          {/* Header */}
          <div className={`shrink-0 text-white py-4 sm:py-5 px-4 sm:px-6 shadow-lg ${
            isCurrentArchived
              ? "bg-amber-800"
              : currentEntry.patientType === "pwd"
                ? "bg-blue-700"
                : "bg-[#166534]"
          }`}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                isCurrentArchived
                  ? "bg-amber-300"
                  : currentEntry.patientType === "pwd"
                    ? "bg-blue-300"
                    : "bg-[#4ade80]"
              }`}>
                {isCurrentArchived ? (
                  <AlertIcon className="w-6 h-6 text-amber-800" />
                ) : currentEntry.patientType === "pwd" ? (
                  <AccessibilityIcon className="w-6 h-6 text-blue-700" />
                ) : (
                  <PillIcon className="w-6 h-6 text-[#166534]" /> )}
              </div>
              <div>
                <h1 className="text-xl font-bold">Your Queue Number</h1>
                <p className={`text-sm ${
                  isCurrentArchived
                    ? "text-amber-200"
                    : currentEntry.patientType === "pwd"
                      ? "text-blue-200"
                      : "text-green-200"
                }`}>
                  {isCurrentArchived
                    ? "Notice: Queue Archived (15-min timeout)"
                    : currentEntry.patientType === "pwd"
                      ? "Priority Queue — PWD Patient"
                      : "Please wait for your turn"}
                </p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 sm:px-6 py-8 max-w-2xl md:max-w-4xl mx-auto">
            {/* Notice Banner if Archived */}
            {isCurrentArchived && (
              <div className="bg-amber-50 border-2 border-amber-400 rounded-2xl p-5 mb-6 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 text-amber-700">
                    <AlertIcon className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-lg font-bold text-amber-900 mb-1">Notice: Get Queue Again</h2>
                    <p className="text-sm text-amber-800 mb-4 leading-relaxed">
                      You did not show up within 15 minutes when your queue was called to &quot;Get Ready&quot;. Your queue number {currentEntry.queueNumber.startsWith("PWD") || currentEntry.queueNumber.startsWith("REG") ? currentEntry.queueNumber : `#${currentEntry.queueNumber}`} has been moved to archive. Please get a queue number again to be served.
                    </p>
                    <button
                      onClick={() => navigate("register")}
                      className="w-full sm:w-auto px-6 py-3 bg-[#166534] hover:bg-[#14532d] text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow"
                    >
                      <RotateCcwIcon className="w-5 h-5" /> Get Queue Again
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Queue Card */}
            <div className={`rounded-3xl overflow-hidden shadow-2xl mb-6 ${
              isCurrentArchived
                ? "bg-gradient-to-br from-amber-800 to-amber-950"
                : currentEntry.patientType === "pwd"
                  ? "bg-gradient-to-br from-blue-700 to-blue-900"
                  : "bg-gradient-to-br from-[#166534] to-[#14532d]"
            }`}>
              <div className="px-4 sm:px-6 pt-6 flex justify-end">
                <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold ${
                  isCurrentArchived
                    ? "bg-amber-200 text-amber-900"
                    : currentEntry.patientType === "pwd"
                      ? "bg-blue-300 text-blue-900"
                      : "bg-[#4ade80] text-[#166534]"
                }`}>
                  {isCurrentArchived
                    ? "Archived — Missed 15 Mins"
                    : currentEntry.patientType === "pwd"
                      ? "Priority"
                      : "Regular"}
                </span>
              </div>
              <div className="text-center px-4 sm:px-6 pt-4 pb-6">
                <p className={`mb-2 text-sm font-medium ${currentEntry.patientType === "pwd" ? "text-blue-300" : "text-green-300"}`}>Queue Number</p>
                <div className={`text-[clamp(2rem,12vw,6rem)] font-black mb-3 tracking-tight break-words ${currentEntry.patientType === "pwd" ? "text-blue-200" : "text-[#4ade80]"}`}>
                  {currentEntry.queueNumber}
                </div>
                <div className={`w-24 h-1.5 mx-auto rounded-full ${currentEntry.patientType === "pwd" ? "bg-blue-400" : "bg-[#4ade80]"}`} />
              </div>
              <div className="px-4 sm:px-6 pb-8 space-y-4 text-white">
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

            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-4 mb-4">
              <button onClick={saveToPhone}
                className="h-14 border-2 border-[#166534] text-[#166534] hover:bg-[#166534] hover:text-white rounded-xl flex items-center justify-center font-medium">
                <DownloadIcon className="w-5 h-5 mr-2" /> Save to Phone
              </button>
              <button onClick={() => navigate("register")}
                className="h-14 border-2 border-gray-300 text-gray-700 hover:border-[#166534] hover:text-[#166534] rounded-xl flex items-center justify-center font-medium">
                <RotateCcwIcon className="w-5 h-5 mr-2" /> Register Again
              </button>
            </div>

              {isCurrentArchived ? (
                <button onClick={() => navigate("register")}
                  className="w-full h-14 bg-[#166534] hover:bg-[#14532d] text-white font-bold text-lg rounded-xl flex items-center justify-center gap-2 mb-4 shadow-lg">
                  <RotateCcwIcon className="w-5 h-5" /> Get Queue Again
                </button>
              ) : (
                <button onClick={() => navigate("track", currentEntry.id)}
                  className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl flex items-center justify-center mb-4">
                  <ClockIcon className="w-5 h-5 mr-2" /> Track My Queue Status
                </button>
              )}

              {/* What's Next */}
              {isCurrentArchived ? (
                <div className="rounded-xl p-5 mb-6 bg-amber-50 border border-amber-200">
                  <h3 className="font-bold mb-2 text-amber-900">Queue Expired</h3>
                  <p className="text-sm text-amber-800 mb-3 leading-relaxed">
                    The 15-minute window to claim your medicine after being called has passed. To receive your medicine, please tap &quot;Get Queue Again&quot; to generate a new queue ticket.
                  </p>
                  <button
                    onClick={() => navigate("register")}
                    className="text-sm font-bold text-[#166534] hover:underline flex items-center gap-1"
                  >
                    Get Queue Again &rarr;
                  </button>
                </div>
              ) : (
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
              )}

            </div>
            </div>

            <div className="customer-app-footer shrink-0 border-t border-gray-200 bg-white px-4 py-2 sm:px-6 sm:py-3">
              <div className="max-w-2xl md:max-w-4xl mx-auto">
                <button onClick={() => navigate("home")}
                  className="h-12 w-full bg-[#166534] hover:bg-[#14532d] text-white font-semibold rounded-xl flex items-center justify-center">
                  <HomeIcon className="w-5 h-5 mr-2" /> Back to Home
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ════════════════ TRACK PAGE ════════════════ */}
      {page === "track" && currentEntry && (() => {
        const isCurrentExpired = isGetReadyExpired(currentEntry, currentTimeMs);
        const isCurrentArchived = currentEntry.status === "archived" || isCurrentExpired;
        return (
        <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-green-50 to-white">
          <div className={`shrink-0 text-white py-4 sm:py-5 px-4 sm:px-6 shadow-lg ${
            isCurrentArchived ? "bg-amber-800" : "bg-[#166534]"
          }`}>
            <div className="flex items-center gap-3">
              <button onClick={() => navigate("queue", currentEntry.id)} className="text-white hover:bg-white/20 p-2 rounded-xl" aria-label="Back to your queue number">
                <ArrowLeftIcon className="w-6 h-6" />
              </button>
              <div>
                <h1 className="text-2xl font-bold">Track My Queue</h1>
                <p className="text-green-200 text-sm">
                  {isCurrentArchived ? "Queue Archived Notice" : "Real-time updates"}
                </p>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-4 sm:px-6 pt-8 pb-6 max-w-2xl md:max-w-4xl mx-auto">
            <div className="text-center mb-10">
              <p className="text-gray-500 text-sm font-medium">YOUR QUEUE NUMBER</p>
              <p className={`text-[clamp(2rem,10vw,4.5rem)] font-bold tracking-tighter mt-2 break-words ${
                isCurrentArchived ? "text-amber-800" : "text-[#166534]"
              }`}>{currentEntry.queueNumber}</p>
              {isCurrentArchived ? (
                <span className="inline-block mt-3 px-5 py-1 bg-amber-100 text-amber-800 text-sm font-semibold rounded-full border border-amber-300">
                  ARCHIVED — MISSED 15 MINS
                </span>
              ) : currentEntry.patientType === "pwd" ? (
                <span className="inline-block mt-3 px-5 py-1 bg-blue-100 text-blue-700 text-sm font-semibold rounded-full">PWD – PRIORITY</span>
              ) : null}
            </div>

            {/* Status Steps */}
            <div className="bg-white rounded-3xl p-4 sm:p-8 mb-8 shadow-sm border border-gray-200">
              <div className="flex justify-between relative mb-10">
                {STATUS_STEPS.map((step, i) => {
                  const currentIndex = isCurrentArchived
                    ? 2
                    : STATUS_STEPS.findIndex((s) => s.key === currentEntry.status);
                  const active = i <= currentIndex;
                  return (
                    <div key={step.key} className="flex flex-col items-center relative z-10">
                      <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-xl transition-all duration-500 ${
                        isCurrentArchived && i === 2
                          ? "bg-amber-500 text-white scale-110 shadow-lg ring-4 ring-amber-200"
                          : active
                            ? "bg-[#166534] text-white scale-110 shadow-lg"
                            : "bg-gray-200 text-gray-400"
                      }`}>
                        {i + 1}
                      </div>
                      <p className={`text-xs font-semibold mt-3 ${
                        isCurrentArchived && i === 2
                          ? "text-amber-700 font-bold"
                          : active
                            ? "text-[#166534]"
                            : "text-gray-400"
                      }`}>
                        {step.label}
                      </p>
                    </div>
                  );
                })}
                {/* Progress line */}
                <div className="absolute top-6 left-0 h-1 bg-gray-200 w-full -z-10">
                  <div className={`h-1 transition-all duration-700 ${isCurrentArchived ? "bg-amber-400" : "bg-[#166534]"}`}
                    style={{
                      width: `${(
                        (isCurrentArchived
                          ? 2
                          : STATUS_STEPS.findIndex((s) => s.key === currentEntry.status)) /
                        (STATUS_STEPS.length - 1)
                      ) * 100}%`
                    }} />
                </div>
              </div>

              {/* Status Message */}
              <div className={`text-center p-4 sm:p-8 rounded-2xl text-lg font-semibold leading-relaxed ${
                isCurrentArchived
                  ? "bg-amber-100 text-amber-900 border-2 border-amber-400"
                  : currentEntry.status === "getready"
                    ? "bg-amber-100 text-amber-700 border-2 border-amber-400"
                    : currentEntry.status === "served"
                      ? "bg-green-100 text-green-700"
                      : currentEntry.status === "processing"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-700"
              }`}>
                {currentEntry.status === "waiting"    && !isCurrentArchived && "Please wait. Your turn is coming soon."}
                {currentEntry.status === "processing" && !isCurrentArchived && "Your medicine is now being prepared by our staff."}
                {currentEntry.status === "getready"   && !isCurrentArchived && (
                  <div className="space-y-2">
                    <div>🎉 YOUR MEDICINE IS READY! Please proceed to the counter now.</div>
                    <div className="text-sm font-normal text-amber-800 bg-amber-200/60 py-1.5 px-3 rounded-lg inline-block">
                      ⏱ Please claim within 15 minutes. Time remaining: <span className="font-bold text-amber-950">{formatRemainingTime(getReadyRemainingMs(currentEntry, currentTimeMs))}</span>
                    </div>
                  </div>
                )}
                {currentEntry.status === "served"     && !isCurrentArchived && "Thank you! You have been served."}
                {isCurrentArchived && (
                  <div className="space-y-3">
                    <div className="text-xl font-black text-amber-900">Notice: Get Queue Again</div>
                    <p className="text-sm font-normal text-amber-800 max-w-md mx-auto">
                      You did not show up within 15 minutes when your queue was called to &quot;Get Ready&quot;. Your queue was moved to archive. Please get a queue number again.
                    </p>
                    <button
                      onClick={() => navigate("register")}
                      className="inline-flex items-center gap-2 px-6 py-3 bg-[#166534] hover:bg-[#14532d] text-white text-base font-bold rounded-xl shadow-md"
                    >
                      <RotateCcwIcon className="w-5 h-5" /> Get Queue Again
                    </button>
                  </div>
                )}
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

          </div>
          </div>

          <div className="customer-app-footer shrink-0 border-t border-gray-200 bg-white px-4 py-2 sm:px-6 sm:py-3">
            <div className="max-w-2xl md:max-w-4xl mx-auto space-y-2">
              <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">
                <button onClick={refreshStatus}
                  className="h-12 bg-[#166534] hover:bg-[#14532d] text-white text-sm sm:text-base font-semibold rounded-xl flex items-center justify-center">
                  <RefreshCwIcon className={`mr-2 w-5 h-5 ${isRefreshing ? "animate-spin" : ""}`} /> Refresh Status
                </button>
                {isCurrentArchived ? (
                  <button onClick={() => navigate("register")}
                    className="h-12 bg-[#166534] hover:bg-[#14532d] text-white text-sm sm:text-base font-bold rounded-xl flex items-center justify-center gap-2 shadow">
                    <RotateCcwIcon className="mr-2 w-5 h-5" /> Get Queue Again
                  </button>
                ) : currentEntry.status === "getready" ? (
                  <button onClick={handleMarkServed} disabled={isMarkingServed}
                    className="h-12 bg-green-600 hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60 text-white text-sm sm:text-base font-semibold rounded-xl flex items-center justify-center">
                    {isMarkingServed ? (
                      <RefreshCwIcon className="mr-2 w-5 h-5 animate-spin" />
                    ) : (
                      <CheckCircleIcon className="mr-2 w-5 h-5" />
                    )}
                    {isMarkingServed ? "Updating..." : "I Have Been Served"}
                  </button>
                ) : null}
              </div>
              <button onClick={() => navigate("home")} className="w-full py-2 text-gray-500 hover:text-gray-700 text-sm font-medium">
                Back to Home
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Fallback if entry not found */}
      {(page === "queue" || page === "track") && !currentEntry && (
        <div className="h-full min-h-0 flex flex-col items-center justify-center gap-4 p-6">
          <p className="text-gray-500 text-lg">Entry not found. Please register again.</p>
          <button onClick={() => navigate("home")} className="px-4 sm:px-6 py-3 bg-[#166534] text-white rounded-xl font-semibold">
            Back to Home
          </button>
        </div>
      )}

      {/* ════════════════ GET QUEUE AGAIN NOTICE MODAL ════════════════ */}
      {queueNoticeModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50 p-4" onClick={() => setQueueNoticeModal(null)}>
          <div className="w-full max-w-md bg-white rounded-3xl p-6 sm:p-8 shadow-2xl relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setQueueNoticeModal(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 p-2 rounded-full hover:bg-gray-100"
              aria-label="Close modal"
            >
              <XIcon className="w-5 h-5" />
            </button>
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 text-amber-600">
              <AlertIcon className="w-8 h-8" />
            </div>
            <div className="text-center mb-6">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-800 bg-amber-100 px-3 py-1 rounded-full border border-amber-300">
                Notice
              </span>
              <h2 className="text-2xl font-black text-gray-900 mt-3 mb-2">Get Queue Again</h2>
              <p className="text-gray-600 text-sm leading-relaxed">
                Queue <span className="font-bold text-gray-900">{queueNoticeModal.queueNumber.startsWith("PWD") || queueNoticeModal.queueNumber.startsWith("REG") ? queueNoticeModal.queueNumber : `#${queueNoticeModal.queueNumber}`}</span> was moved to <span className="font-bold text-amber-900">Archive</span> because you did not show up within 15 minutes while your status was in &quot;Get Ready&quot;.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6 text-xs text-amber-800 space-y-1">
              <p className="font-bold text-amber-900">What should you do?</p>
              <p>Please get a new queue number to receive your medicine. Our staff will call your medicine when your new number comes up.</p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => {
                  setQueueNoticeModal(null);
                  navigate("register");
                }}
                className="w-full h-13 bg-[#166534] hover:bg-[#14532d] text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg text-base"
              >
                <RotateCcwIcon className="w-5 h-5" />
                Get Queue Again
              </button>
              <button
                onClick={() => {
                  const id = queueNoticeModal.id;
                  setQueueNoticeModal(null);
                  navigate("queue", id);
                }}
                className="w-full h-12 border-2 border-gray-200 hover:border-gray-300 text-gray-700 font-semibold rounded-xl flex items-center justify-center gap-2"
              >
                View Queue Details
              </button>
            </div>
          </div>
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
function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
