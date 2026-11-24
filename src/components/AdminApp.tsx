"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import {
  subscribeStockItems,
  subscribeQueueEntries,
  addStockItem,
  updateStockItem,
  deleteStockItem,
  setStockItemAvailability,
  isStockItemAvailable,
  updateQueueEntryStatus,
  deleteQueueEntry,
  getQueueEntriesForDateRange,
  isGetReadyExpired,
  getReadyRemainingMs,
  type StockItem,
  type QueueEntry,
} from "@/lib/firestore";

// Add this at the top of your app/admin/page.tsx file
export const dynamic = "force-dynamic";

const CUSTOMER_APP_URL = process.env.NEXT_PUBLIC_CUSTOMER_URL || "/customer";

function formatQueueDisplay(num: string): string {
  return /^(PWD|REG|P|R)\d+$/i.test(num) ? num : `#${num}`;
}

const APPROACHING_QUEUE_OFFSET = 4; // 5th number starting from the processing entry (e.g. R006 -> R010)

function parseQueueNumber(
  queueNumber: string,
): { prefix: string; number: number } | null {
  const match = queueNumber.trim().match(/^([A-Za-z]*)(\d+)$/);
  if (!match) return null;
  const parsedNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(parsedNumber)) return null;
  return {
    prefix: match[1].toUpperCase(),
    number: parsedNumber,
  };
}

function findApproachingQueueEntry(
  processingEntry: QueueEntry,
  allEntries: QueueEntry[],
): QueueEntry | null {
  const currentParsed = parseQueueNumber(processingEntry.queueNumber);
  if (!currentParsed) return null;
  const targetNumber = currentParsed.number + APPROACHING_QUEUE_OFFSET;

  return (
    allEntries.find((candidate) => {
      if (candidate.id === processingEntry.id) return false;
      if (candidate.patientType !== processingEntry.patientType) return false;
      if (candidate.status !== "waiting") return false;
      const candidateParsed = parseQueueNumber(candidate.queueNumber);
      if (!candidateParsed) return false;
      if (
        currentParsed.prefix &&
        candidateParsed.prefix &&
        currentParsed.prefix !== candidateParsed.prefix
      ) {
        return false;
      }
      return candidateParsed.number === targetNumber;
    }) ?? null
  );
}

function formatRemainingTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

async function verifyAdminAccess(user: User): Promise<boolean> {
  const idToken = await user.getIdToken(true);
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiBaseUrl && process.env.NEXT_PUBLIC_ADMIN_STATIC === "true") {
    throw new Error(
      "Set VITE_API_BASE_URL for the standalone Admin deployment.",
    );
  }
  const sessionUrl = apiBaseUrl
    ? `${apiBaseUrl.replace(/\/$/, "")}/api/admin/session`
    : "/api/admin/session";
  const response = await fetch(sessionUrl, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: "no-store",
  });

  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) {
    throw new Error("Could not verify admin access.");
  }

  return true;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type AdminPage = "dashboard" | "queue" | "medicines";
type QueueFilter =
  | "all"
  | "waiting"
  | "processing"
  | "getready"
  | "served"
  | "archived";
type ReportPeriod = "daily" | "weekly" | "monthly" | "yearly" | "custom";

const MEDICINE_CATEGORIES = [
  "Prescription drugs",
  "Over-the-counter (OTC) drugs",
  "Analgesics and antipyretics",
  "Antibiotics and antivirals",
  "Cardiovascular drugs",
  "Respiratory drugs",
  "Gastrointestinal drugs",
  "Endocrine and metabolic drugs",
  "Central nervous system & psychiatric drugs",
] as const;

function getStockStatus(stock: number, available: boolean) {
  if (stock <= 0) {
    return {
      label: "Out of Stock",
      color: "text-red-700 bg-red-50 border-red-200",
    };
  }
  if (!available) {
    return {
      label: "Unavailable",
      color: "text-gray-700 bg-gray-50 border-gray-200",
    };
  }
  if (stock < 50) {
    return {
      label: "Low Stock",
      color: "text-amber-700 bg-amber-50 border-amber-200",
    };
  }
  return {
    label: "In Stock",
    color: "text-emerald-700 bg-emerald-50 border-emerald-200",
  };
}

function normalizeMedName(name: string): string {
  return name.trim().toLowerCase();
}

function getStockBatchInfo(
  med: StockItem,
  allMedicines: StockItem[],
): {
  role: "old" | "new";
  hasMultipleBatches: boolean;
  hasActiveOldStock: boolean;
} {
  const key = normalizeMedName(med.name);
  const sameNameMeds = allMedicines.filter(
    (item) => normalizeMedName(item.name) === key,
  );
  if (sameNameMeds.length > 1) {
    const isOldestActive = sameNameMeds[0]?.id === med.id;
    const oldStockQty = sameNameMeds[0]?.stock ?? 0;
    return {
      role: isOldestActive ? "old" : "new",
      hasMultipleBatches: true,
      hasActiveOldStock: !isOldestActive && oldStockQty > 0,
    };
  }
  return {
    role: med.isNewStock ? "new" : "old",
    hasMultipleBatches: false,
    hasActiveOldStock: false,
  };
}

function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDaysUntilExpiration(
  expirationDate: string,
  today: string,
): number | null {
  const toDayNumber = (date: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const [year, month, day] = date.split("-").map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    return new Date(timestamp).toISOString().slice(0, 10) === date
      ? timestamp / 86_400_000
      : null;
  };
  const expiryDay = toDayNumber(expirationDate);
  const todayDay = toDayNumber(today);
  return expiryDay === null || todayDay === null ? null : expiryDay - todayDay;
}

function getExpirationLabel(daysUntilExpiration: number): string {
  if (daysUntilExpiration < 0) {
    const days = Math.abs(daysUntilExpiration);
    return `Expired ${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (daysUntilExpiration === 0) return "Expires today";
  return `Expires in ${daysUntilExpiration} day${daysUntilExpiration === 1 ? "" : "s"}`;
}

const STATUS_CONFIG = {
  waiting: {
    label: "Waiting",
    badge: "bg-amber-100 text-amber-800 border-amber-200",
    dot: "bg-amber-400",
  },
  processing: {
    label: "Processing",
    badge: "bg-blue-100 text-blue-800 border-blue-200",
    dot: "bg-blue-500",
  },
  getready: {
    label: "Get Ready",
    badge: "bg-orange-100 text-orange-800 border-orange-200",
    dot: "bg-orange-400",
  },
  served: {
    label: "Served",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-200",
    dot: "bg-emerald-500",
  },
  archived: {
    label: "Archived",
    badge: "bg-gray-100 text-gray-800 border-gray-200",
    dot: "bg-gray-500",
  },
} as const;

// ─── Toast ───────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState<
    { id: number; msg: string; type: string }[]
  >([]);
  const show = useCallback((msg: string, type = "success") => {
    const id = Date.now();
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 2800);
  }, []);
  return { toasts, show };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function LoginPage({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (
        msg.includes("invalid-credential") ||
        msg.includes("wrong-password") ||
        msg.includes("user-not-found")
      ) {
        setError("Invalid email or password.");
      } else if (
        msg.includes("api-key-not-valid") ||
        msg.includes("invalid-api-key")
      ) {
        setError(
          "Firebase rejected the API key. Check the web app config in your environment and restart the app.",
        );
      } else if (msg.includes("operation-not-allowed")) {
        setError(
          "Email/Password sign-in is disabled. Enable it in Firebase Authentication settings.",
        );
      } else if (msg.includes("network")) {
        setError("Network error. Please check your connection.");
      } else if (msg.includes("admin-required")) {
        setError("This account is not authorized for the Admin Dashboard.");
      } else {
        setError("Login failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-700 rounded-2xl mb-4 shadow-lg">
            <PillIcon className="w-9 h-9 text-white" />
          </div>
          <h1 className="text-3xl font-extrabold text-emerald-700">
            MediServe Admin
          </h1>
          <p className="text-gray-500 mt-2 text-sm">
            City Health Pharmacy Management
          </p>
        </div>

        <div className="bg-white rounded-3xl shadow-xl border border-emerald-100 p-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">Sign In</h2>

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm font-medium flex items-center gap-2">
              <AlertCircleIcon className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="Enter your email"
                className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-600 focus:outline-none text-base"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Enter your password"
                  className="w-full h-12 px-4 pr-12 rounded-xl border border-gray-200 focus:border-emerald-600 focus:outline-none text-base"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((p) => !p)}
                  className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
                >
                  {showPw ? (
                    <EyeOffIcon className="w-5 h-5" />
                  ) : (
                    <EyeIcon className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-12 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-bold rounded-xl text-base transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <SpinnerIcon className="w-5 h-5 animate-spin" />
              ) : (
                <LogInIcon className="w-5 h-5" />
              )}
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Admin access only · No sign-up available
        </p>
        <div className="text-center mt-3">
          <a
            href={CUSTOMER_APP_URL}
            className="text-sm text-emerald-700 hover:underline"
          ></a>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ADMIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function AdminApp() {
  const { toasts, show: showToast } = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState<AdminPage>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expiryNotificationsOpen, setExpiryNotificationsOpen] = useState(false);
  const [expiryToday, setExpiryToday] = useState<string | null>(null);
  const [focusedMedicine, setFocusedMedicine] = useState<{
    id: string;
    requestId: number;
  } | null>(null);
  const medicineFocusRequestId = useRef(0);

  // Data
  const [medicines, setMedicines] = useState<StockItem[]>([]);
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now());
  const [updatingQueueIds, setUpdatingQueueIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    const timer = setInterval(() => setCurrentTimeMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getReadyEntry =
    entries.find(
      (entry) =>
        entry.status === "getready" &&
        !entry.wasServed &&
        !isGetReadyExpired(entry, currentTimeMs),
    ) ?? null;

  // Auto-archive getready entries exceeding 15 minutes
  useEffect(() => {
    const checkAndArchive = async () => {
      const now = Date.now();
      const expiredEntries = entries.filter(
        (e) =>
          e.status === "getready" &&
          isGetReadyExpired(e, now) &&
          !updatingQueueIds.has(e.id),
      );

      for (const entry of expiredEntries) {
        setUpdatingQueueIds((curr) => new Set(curr).add(entry.id));
        try {
          await updateQueueEntryStatus(entry.id, "archived", {
            archivedReason: "no_show",
          });
          showToast(
            `Queue ${formatQueueDisplay(entry.queueNumber)} (${entry.patientName}) moved to archive — did not show within 15 mins.`,
            "warning",
          );
        } catch (error) {
          console.error("Could not auto-archive expired entry:", error);
        } finally {
          setUpdatingQueueIds((curr) => {
            const next = new Set(curr);
            next.delete(entry.id);
            return next;
          });
        }
      }
    };

    checkAndArchive();
    const interval = setInterval(checkAndArchive, 4000);
    return () => clearInterval(interval);
  }, [entries, updatingQueueIds, showToast]);

  // Queue state
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [selectedEntry, setSelectedEntry] = useState<QueueEntry | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!modalOpen || !selectedEntry) return;
    const liveEntry = entries.find((entry) => entry.id === selectedEntry.id);
    if (!liveEntry || liveEntry.status === "archived") {
      setModalOpen(false);
    }
  }, [entries, modalOpen, selectedEntry]);

  // Medicine modal state
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [editingMed, setEditingMed] = useState<StockItem | null>(null);
  const [medForm, setMedForm] = useState({
    name: "",
    type: "",
    stock: 0,
    available: true,
    genericName: "",
    dosageStrength: "",
    dosageForm: "",
    unitOfMeasurement: "",
    batchNumber: "",
    minimumStock: 0,
    storageLocation: "",
    manufacturingDate: "",
    expirationDate: "",
    receivedDate: "",
  });
  const [medLoading, setMedLoading] = useState(false);
  const [medicineTypeFilter, setMedicineTypeFilter] = useState("all");
  const alertedLowStockIds = useRef(new Set<string>());
  const alertedExpiryKeys = useRef(new Set<string>());
  const activatingNewStockIds = useRef(new Set<string>());
  const prevStockQuantities = useRef(new Map<string, number>());
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>("daily");
  const [reportCategory, setReportCategory] = useState("all");
  const [reportMedicine, setReportMedicine] = useState("all");
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [reportHistoryEntries, setReportHistoryEntries] = useState<
    QueueEntry[]
  >([]);
  const [reportHistoryLoading, setReportHistoryLoading] = useState(false);

  useEffect(() => {
    const updateToday = () => setExpiryToday(getLocalDateKey(new Date()));
    updateToday();
    const intervalId = window.setInterval(updateToday, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (currentPage !== "medicines" || !focusedMedicine) return;

    const frameId = window.requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-medicine-id]"),
      ).find(
        (element) =>
          element.dataset.medicineId === focusedMedicine.id &&
          element.getClientRects().length > 0,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timeoutId = window.setTimeout(() => {
      setFocusedMedicine((current) =>
        current?.requestId === focusedMedicine.requestId ? null : current,
      );
    }, 2500);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [currentPage, focusedMedicine]);

  // ─── Auth ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const unsub = onAuthStateChanged(auth, async (authenticatedUser) => {
      if (active) setAuthLoading(true);

      if (!authenticatedUser) {
        if (active) {
          setUser(null);
          setAuthLoading(false);
        }
        return;
      }

      try {
        if (!(await verifyAdminAccess(authenticatedUser))) {
          await signOut(auth);
          if (active) {
            setUser(null);
            window.alert(
              "Admin access required. Redirecting to the customer dashboard.",
            );
            window.location.replace(CUSTOMER_APP_URL);
          }
        } else if (active) {
          setUser(authenticatedUser);
        }
      } catch (error) {
        await signOut(auth);
        if (active) {
          setUser(null);
          console.error("Could not verify admin access:", error);
          showToast(
            "Unable to verify admin access. Please try again.",
            "error",
          );
        }
      } finally {
        if (active) setAuthLoading(false);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, [showToast]);

  async function handleLogin(email: string, password: string): Promise<void> {
    const credential = await signInWithEmailAndPassword(auth, email, password);

    if (!(await verifyAdminAccess(credential.user))) {
      await signOut(auth);
      throw new Error("admin-required");
    }
  }

  async function handleLogout() {
    await signOut(auth);
    showToast("Signed out successfully");
  }

  // ─── Firestore subscriptions ──────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const unsubStock = subscribeStockItems(setMedicines);
    const unsubQueue = subscribeQueueEntries(setEntries);
    return () => {
      unsubStock();
      unsubQueue();
    };
  }, [user]);

  useEffect(() => {
    if (!user || reportPeriod === "daily") {
      setReportHistoryEntries([]);
      setReportHistoryLoading(false);
      return;
    }

    let startDate = reportStartDate;
    let endDate = reportEndDate;
    if (reportPeriod !== "custom") {
      const now = new Date();
      const start = new Date(now);
      if (reportPeriod === "weekly") {
        start.setDate(now.getDate() - 6);
      } else if (reportPeriod === "monthly") {
        start.setDate(1);
      } else {
        start.setMonth(0, 1);
      }
      start.setHours(0, 0, 0, 0);
      const toDateInput = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      };
      startDate = toDateInput(start);
      endDate = toDateInput(now);
    }

    if (!startDate || !endDate || startDate > endDate) {
      setReportHistoryEntries([]);
      setReportHistoryLoading(false);
      return;
    }

    let active = true;
    setReportHistoryEntries([]);
    setReportHistoryLoading(true);
    getQueueEntriesForDateRange(startDate, endDate)
      .then((historicalEntries) => {
        if (active) setReportHistoryEntries(historicalEntries);
      })
      .catch((error: unknown) => {
        console.error(
          "Could not load dispensing report for the selected period:",
          error,
        );
        if (active) {
          setReportHistoryEntries([]);
          showToast(
            "Could not load the dispensing report for this period",
            "error",
          );
        }
      })
      .finally(() => {
        if (active) setReportHistoryLoading(false);
      });

    return () => {
      active = false;
    };
  }, [user, reportPeriod, reportStartDate, reportEndDate, showToast]);

  useEffect(() => {
    if (!medicines.length) return;

    medicines.forEach((med) => {
      if (
        med.stock > 0 &&
        med.stock <= 50 &&
        !alertedLowStockIds.current.has(med.id)
      ) {
        alertedLowStockIds.current.add(med.id);
        showToast(
          `Low stock alert: ${med.name} has ${med.stock} remaining`,
          "error",
        );
      } else if (med.stock <= 0 || med.stock > 50) {
        alertedLowStockIds.current.delete(med.id);
      }
    });
  }, [medicines, showToast]);

  // Automatically manage Old Stock -> New Stock availability transition:
  // 1. When a New Stock exists alongside an Old Stock that still has quantity > 0, New Stock stays Unavailable.
  // 2. As soon as Old Stock hits 0 quantity, New Stock automatically becomes Available.
  useEffect(() => {
    if (!medicines.length) return;

    const groups = new Map<string, StockItem[]>();
    medicines.forEach((med) => {
      const key = normalizeMedName(med.name);
      const list = groups.get(key) ?? [];
      list.push(med);
      groups.set(key, list);
    });

    groups.forEach((group) => {
      if (group.length <= 1) return;

      const oldBatches = group.filter(
        (item) => getStockBatchInfo(item, medicines).role === "old",
      );
      const newBatches = group.filter(
        (item) => getStockBatchInfo(item, medicines).role === "new",
      );

      const anyOldStockHasQuantity = oldBatches.some((b) => b.stock > 0);
      const oldStockJustHitZero = oldBatches.some((b) => {
        const prev = prevStockQuantities.current.get(b.id);
        return prev !== undefined && prev > 0 && b.stock === 0;
      });
      const anyNewStockAvailable = newBatches.some((b) =>
        isStockItemAvailable(b),
      );

      // 1. While Old Stock still has quantity > 0, ensure any New Stock is automatically Unavailable
      if (anyOldStockHasQuantity) {
        newBatches.forEach((nb) => {
          if (
            (isStockItemAvailable(nb) || nb.waitingForOldStock !== true) &&
            !activatingNewStockIds.current.has(nb.id)
          ) {
            activatingNewStockIds.current.add(nb.id);
            setStockItemAvailability(nb.id, false, {
              waitingForOldStock: true,
            })
              .catch((error) => {
                console.error(
                  "Could not set new stock to standby unavailable:",
                  error,
                );
              })
              .finally(() => {
                activatingNewStockIds.current.delete(nb.id);
              });
          }
        });
      }

      // 2. When Old Stock is at 0 quantity and no New Stock is available yet, automatically make the first New Stock with quantity > 0 available
      if (!anyOldStockHasQuantity && !anyNewStockAvailable) {
        const candidateNewBatch = newBatches.find(
          (b) =>
            b.stock > 0 &&
            (b.waitingForOldStock === true || oldStockJustHitZero),
        );
        if (
          candidateNewBatch &&
          !activatingNewStockIds.current.has(candidateNewBatch.id)
        ) {
          activatingNewStockIds.current.add(candidateNewBatch.id);
          setStockItemAvailability(candidateNewBatch.id, true)
            .then(() => {
              showToast(
                `Old stock of ${candidateNewBatch.name} reached 0 — New stock is now automatically Available!`,
              );
            })
            .catch((error) => {
              console.error("Could not auto-activate new stock:", error);
            })
            .finally(() => {
              activatingNewStockIds.current.delete(candidateNewBatch.id);
            });
        }
      }
    });

    const nextMap = new Map<string, number>();
    medicines.forEach((med) => {
      nextMap.set(med.id, med.stock);
    });
    prevStockQuantities.current = nextMap;
  }, [medicines, showToast]);

  useEffect(() => {
    if (!expiryToday) return;

    const newAlerts = medicines.flatMap((medicine) => {
      if (!medicine.expirationDate || medicine.stock <= 0) return [];
      const daysUntilExpiration = getDaysUntilExpiration(
        medicine.expirationDate,
        expiryToday,
      );
      if (daysUntilExpiration === null || daysUntilExpiration > 5) return [];

      const alertKey = `${medicine.id}:${medicine.expirationDate}`;
      if (alertedExpiryKeys.current.has(alertKey)) return [];
      alertedExpiryKeys.current.add(alertKey);
      return [{ medicine, daysUntilExpiration }];
    });

    if (newAlerts.length === 1) {
      const { medicine, daysUntilExpiration } = newAlerts[0];
      showToast(
        `${medicine.name}: ${getExpirationLabel(daysUntilExpiration)}`,
        "warning",
      );
    } else if (newAlerts.length > 1) {
      showToast(
        `${newAlerts.length} medicines are expiring within 5 days. Check the notification bell.`,
        "warning",
      );
    }
  }, [expiryToday, medicines, showToast]);

  // ─── Navigation ──────────────────────────────────────────────────────────
  function navigate(page: AdminPage) {
    setCurrentPage(page);
    setSidebarOpen(false);
    setExpiryNotificationsOpen(false);
    if (page !== "medicines") setFocusedMedicine(null);
  }

  // ─── Queue actions ────────────────────────────────────────────────────────
  async function sendQueueSms(phoneNumber: string, message: string) {
    if (!user) throw new Error("Admin session is unavailable.");
    const token = await user.getIdToken();
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiBaseUrl && process.env.NEXT_PUBLIC_ADMIN_STATIC === "true") {
      throw new Error(
        "Set VITE_API_BASE_URL for the standalone Admin deployment.",
      );
    }
    const smsUrl = apiBaseUrl
      ? `${apiBaseUrl.replace(/\/$/, "")}/api/sms`
      : "/api/sms";
    const response = await fetch(smsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        phoneNumber,
        message,
      }),
    });
    if (!response.ok) {
      throw new Error(`SMS API returned HTTP ${response.status}.`);
    }
  }

  async function handleUpdateStatus(id: string, status: QueueEntry["status"]) {
    if (updatingQueueIds.has(id)) return;
    if (status === "getready" && getReadyEntry && getReadyEntry.id !== id) {
      showToast(
        `Queue ${formatQueueDisplay(getReadyEntry.queueNumber)} is currently in "Get Ready". Mark them as Served before setting another patient to Get Ready.`,
        "error",
      );
      return;
    }

    const entry = entries.find((candidate) => candidate.id === id);
    setUpdatingQueueIds((current) => new Set(current).add(id));
    try {
      await updateQueueEntryStatus(id, status);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to update status",
        "error",
      );
      return;
    } finally {
      setUpdatingQueueIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }

    if (status === "processing" && entry && entry.status !== "processing") {
      const targetEntry = findApproachingQueueEntry(entry, entries);
      if (!targetEntry) {
        showToast(`Status updated to ${STATUS_CONFIG[status].label}`);
        return;
      }
      if (!targetEntry.phone) {
        showToast(
          `${entry.queueNumber} is now Processing; ${targetEntry.queueNumber} has no phone number registered`,
        );
        return;
      }

      try {
        await sendQueueSms(
          targetEntry.phone,
          `Queue number ${entry.queueNumber} is now in processing. Please prepare — your turn is approaching.`,
        );
        showToast(
          `${entry.queueNumber} marked as Processing; SMS sent to ${targetEntry.queueNumber}`,
        );
      } catch (error) {
        console.error("Could not send approaching-turn SMS:", error);
        showToast(
          `Status updated, but SMS to ${targetEntry.queueNumber} could not be sent`,
          "error",
        );
      }
      return;
    }

    if (status !== "getready" || !entry || entry.status === "getready") {
      showToast(`Status updated to ${STATUS_CONFIG[status].label}`);
      return;
    }
    if (!entry.phone) {
      showToast(
        `${entry.patientName} marked as Get Ready; no phone number is registered`,
      );
      return;
    }

    try {
      await sendQueueSms(
        entry.phone,
        `Hello ${entry.patientName} (Queue ${entry.queueNumber}), YOUR MEDICINE IS READY! Please proceed to the counter within 15 minutes.`,
      );
      showToast(`${entry.patientName} marked as Get Ready; SMS sent`);
    } catch (error) {
      console.error("Could not send queue-ready SMS:", error);
      showToast("Status updated, but the SMS could not be sent", "error");
    }
  }

  async function handleDeleteEntry(id: string, queueNumber: string) {
    if (!confirm(`Remove ${queueNumber} from queue?`)) return;
    try {
      await deleteQueueEntry(id);
      showToast(`Removed ${queueNumber}`);
      setModalOpen(false);
    } catch {
      showToast("Failed to remove entry", "error");
    }
  }

  // ─── Medicine actions ─────────────────────────────────────────────────────
  function openAddMed(
    category = medicineTypeFilter === "all"
      ? MEDICINE_CATEGORIES[0]
      : medicineTypeFilter,
  ) {
    setEditingMed(null);
    setMedForm({
      name: "",
      type: MEDICINE_CATEGORIES.includes(
        category as (typeof MEDICINE_CATEGORIES)[number],
      )
        ? category
        : MEDICINE_CATEGORIES[0],
      stock: 0,
      available: true,
      genericName: "",
      dosageStrength: "",
      dosageForm: "",
      unitOfMeasurement: "",
      batchNumber: "",
      minimumStock: 0,
      storageLocation: "",
      manufacturingDate: "",
      expirationDate: "",
      receivedDate: "",
    });
    setMedModalOpen(true);
  }

  function openEditMed(med: StockItem) {
    setEditingMed(med);
    const category = MEDICINE_CATEGORIES.includes(
      med.type as (typeof MEDICINE_CATEGORIES)[number],
    )
      ? med.type
      : MEDICINE_CATEGORIES[0];
    setMedForm({
      name: med.name,
      type: category,
      stock: med.stock,
      available: med.available,
      genericName: med.genericName || "",
      dosageStrength: med.dosageStrength || "",
      dosageForm: med.dosageForm || "",
      unitOfMeasurement: med.unitOfMeasurement || "",
      batchNumber: med.batchNumber || "",
      minimumStock: med.minimumStock || 0,
      storageLocation: med.storageLocation || "",
      manufacturingDate: med.manufacturingDate || "",
      expirationDate: med.expirationDate || "",
      receivedDate: med.receivedDate || "",
    });
    setMedModalOpen(true);
  }

  async function handleMedSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !medForm.name.trim() ||
      !medForm.genericName.trim() ||
      !medForm.type.trim() ||
      !medForm.dosageStrength.trim() ||
      !medForm.dosageForm.trim() ||
      !medForm.unitOfMeasurement.trim() ||
      !medForm.batchNumber.trim() ||
      !medForm.expirationDate ||
      !medForm.receivedDate
    ) {
      showToast("Please fill all required fields", "error");
      return;
    }
    setMedLoading(true);
    try {
      const medicineData = {
        ...medForm,
        manualUnavailable: editingMed?.manualUnavailable ?? false,
        available: medForm.stock > 0,
      };
      if (editingMed) {
        const wasPositive = editingMed.stock > 0;
        await updateStockItem(editingMed.id, medicineData);
        if (
          wasPositive &&
          medForm.stock === 0 &&
          medicines.some(
            (m) =>
              m.id !== editingMed.id &&
              normalizeMedName(m.name) === normalizeMedName(medForm.name) &&
              m.stock > 0,
          )
        ) {
          showToast(
            `Old stock of ${medForm.name} reached 0 — New stock is now automatically Available!`,
          );
        } else {
          showToast("Medicine updated successfully");
        }
      } else {
        const hasActiveOldBatch = medicines.some(
          (m) =>
            normalizeMedName(m.name) === normalizeMedName(medForm.name) &&
            m.stock > 0,
        );
        await addStockItem(medicineData);
        if (hasActiveOldBatch) {
          showToast(
            `New stock of ${medForm.name} added as Unavailable — will automatically become Available when Old Stock reaches 0`,
          );
        } else {
          showToast("Medicine added successfully");
        }
      }
      setMedModalOpen(false);
    } catch (error) {
      console.error("Could not save medicine:", error);
      showToast(
        error instanceof Error ? error.message : "Failed to save medicine",
        "error",
      );
    } finally {
      setMedLoading(false);
    }
  }

  async function handleToggleAvailable(med: StockItem) {
    const currentlyAvailable = isStockItemAvailable(med);
    if (!currentlyAvailable && med.stock <= 0) {
      showToast("Restock this medicine before marking it available", "error");
      return;
    }
    const batchInfo = getStockBatchInfo(med, medicines);
    if (!currentlyAvailable && batchInfo.hasActiveOldStock) {
      showToast(
        "New stock will automatically become available when the old stock reaches 0 quantity",
        "warning",
      );
      return;
    }
    try {
      await setStockItemAvailability(med.id, !currentlyAvailable, {
        waitingForOldStock:
          currentlyAvailable && batchInfo.hasActiveOldStock,
      });
      showToast(
        currentlyAvailable
          ? "Medicine marked unavailable"
          : "Medicine marked available",
      );
    } catch (error) {
      console.error("Could not update medicine availability:", error);
      showToast(
        error instanceof Error
          ? error.message
          : "Failed to update availability",
        "error",
      );
    }
  }

  function openQueueEntry(entry: QueueEntry) {
    if (entry.status === "archived") return;
    if (entry.status === "served") return;
    setSelectedEntry(entry);
    setModalOpen(true);
  }

  // ─── Computed values ──────────────────────────────────────────────────────
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.patientType === "pwd" && b.patientType !== "pwd") return -1;
    if (a.patientType !== "pwd" && b.patientType === "pwd") return 1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  const activeQueueEntries = sortedEntries.filter(
    (entry) =>
      entry.status !== "served" &&
      entry.status !== "archived" &&
      !(entry.status === "getready" && isGetReadyExpired(entry, currentTimeMs)),
  );
  const filteredEntries =
    queueFilter === "all"
      ? activeQueueEntries
      : queueFilter === "archived"
        ? sortedEntries.filter(
            (e) =>
              e.status === "archived" ||
              (e.status === "getready" && isGetReadyExpired(e, currentTimeMs)),
          )
        : sortedEntries.filter(
            (e) =>
              e.status === queueFilter &&
              !(e.status === "getready" && isGetReadyExpired(e, currentTimeMs)),
          );

  const counts = {
    all: activeQueueEntries.length,
    waiting: entries.filter((e) => e.status === "waiting").length,
    processing: entries.filter((e) => e.status === "processing").length,
    getready: entries.filter(
      (e) => e.status === "getready" && !isGetReadyExpired(e, currentTimeMs),
    ).length,
    served: entries.filter((e) => e.status === "served").length,
    archived: entries.filter(
      (e) =>
        e.status === "archived" ||
        (e.status === "getready" && isGetReadyExpired(e, currentTimeMs)),
    ).length,
  };

  const lowStockMeds = medicines.filter((m) => m.stock > 0 && m.stock <= 50);
  const expiringMedicines = expiryToday
    ? medicines
        .flatMap((medicine) => {
          if (!medicine.expirationDate || medicine.stock <= 0) return [];
          const daysUntilExpiration = getDaysUntilExpiration(
            medicine.expirationDate,
            expiryToday,
          );
          return daysUntilExpiration !== null && daysUntilExpiration <= 5
            ? [{ medicine, daysUntilExpiration }]
            : [];
        })
        .sort((a, b) => a.daysUntilExpiration - b.daysUntilExpiration)
    : [];
  const medicineTypes = MEDICINE_CATEGORIES;
  const filteredMedicines = (
    medicineTypeFilter === "all"
      ? [...medicines]
      : medicines.filter((med) => med.type.trim() === medicineTypeFilter)
  ).sort((a, b) => {
    const nameCompare = normalizeMedName(a.name).localeCompare(
      normalizeMedName(b.name),
    );
    if (nameCompare !== 0) return nameCompare;
    const aRole = getStockBatchInfo(a, medicines).role === "old" ? 0 : 1;
    const bRole = getStockBatchInfo(b, medicines).role === "old" ? 0 : 1;
    return aRole - bRole;
  });

  const reportSourceEntries =
    reportPeriod === "daily" ? entries : reportHistoryEntries;
  const reportEntries = reportSourceEntries.filter((entry) => {
    if (entry.status !== "served" && !entry.wasServed) return false;
    const entryDate = new Date(entry.dispensedAt ?? entry.timestamp);
    const now = new Date();
    let inPeriod = true;

    if (reportPeriod === "daily") {
      inPeriod = entryDate.toDateString() === now.toDateString();
    } else if (reportPeriod === "weekly") {
      const start = new Date(now);
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      inPeriod = entryDate >= start && entryDate <= now;
    } else if (reportPeriod === "monthly") {
      inPeriod =
        entryDate.getFullYear() === now.getFullYear() &&
        entryDate.getMonth() === now.getMonth();
    } else if (reportPeriod === "yearly") {
      inPeriod = entryDate.getFullYear() === now.getFullYear();
    } else if (reportPeriod === "custom") {
      if (!reportStartDate || !reportEndDate) {
        inPeriod = false;
      } else {
        const start = new Date(`${reportStartDate}T00:00:00`);
        const end = new Date(`${reportEndDate}T23:59:59`);
        inPeriod = entryDate >= start && entryDate <= end;
      }
    }

    if (!inPeriod) return false;

    if (reportCategory !== "all") {
      const categoryNames = medicines
        .filter((med) => med.type === reportCategory)
        .map((med) => med.name);
      const hasCategoryMedicine = entry.medicines.some((med) =>
        categoryNames.includes(med),
      );
      if (!hasCategoryMedicine) return false;
    }

    if (reportMedicine !== "all" && !entry.medicines.includes(reportMedicine)) {
      return false;
    }

    return true;
  });

  const reportMedicineNames = [
    ...new Set([
      ...medicines.map((med) => med.name),
      ...entries.flatMap((entry) => entry.medicines),
    ]),
  ].sort();

  const reportProductTotals = reportMedicineNames
    .filter((name) => reportMedicine === "all" || reportMedicine === name)
    .filter((name) => {
      if (reportCategory === "all") return true;
      return medicines.some(
        (med) => med.name === name && med.type === reportCategory,
      );
    })
    .map((name) => ({
      name,
      quantity: reportEntries.reduce((total, entry) => {
        const index = entry.medicines.indexOf(name);
        return total + (index >= 0 ? (entry.quantities[index] ?? 1) : 0);
      }, 0),
    }))
    .filter((item) => item.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity);

  const reportTotalUnits = reportProductTotals.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  // ─── Loading / Auth gate ─────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-emerald-50">
        <SpinnerIcon className="w-10 h-10 text-emerald-700 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // ─── Sidebar nav items ────────────────────────────────────────────────────
  const navItems: { key: AdminPage; label: string; icon: React.ReactNode }[] = [
    {
      key: "dashboard",
      label: "Dashboard",
      icon: <HomeIcon className="w-5 h-5" />,
    },
    {
      key: "queue",
      label: "Queue Management",
      icon: <UsersIcon className="w-5 h-5" />,
    },
    {
      key: "medicines",
      label: "Medicine Inventory",
      icon: <BoxIcon className="w-5 h-5" />,
    },
  ];

  const renderExpiryBell = () => (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpiryNotificationsOpen((open) => !open)}
        aria-label={`Expiration notifications${expiringMedicines.length ? `, ${expiringMedicines.length} medicines` : ""}`}
        aria-expanded={expiryNotificationsOpen}
        className="relative flex h-10 w-10 items-center justify-center rounded-xl text-gray-600 hover:bg-emerald-50 hover:text-emerald-700"
      >
        <BellIcon className="h-5 w-5" />
        {expiringMedicines.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {expiringMedicines.length > 99 ? "99+" : expiringMedicines.length}
          </span>
        )}
      </button>

      {expiryNotificationsOpen && (
        <div className="absolute right-0 top-full z-[60] mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
          <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
            <div>
              <p className="font-bold text-gray-900">Expiration alerts</p>
              <p className="text-xs text-gray-500">
                Medicines expiring within 5 days
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExpiryNotificationsOpen(false)}
              aria-label="Close expiration alerts"
              className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          {expiringMedicines.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">
              No medicines expiring within 5 days.
            </p>
          ) : (
            <div className="max-h-[60vh] divide-y divide-gray-100 overflow-y-auto">
              {expiringMedicines.map(({ medicine, daysUntilExpiration }) => (
                <button
                  key={`${medicine.id}:${medicine.expirationDate}`}
                  type="button"
                  onClick={() => {
                    setFocusedMedicine({
                      id: medicine.id,
                      requestId: ++medicineFocusRequestId.current,
                    });
                    setMedicineTypeFilter("all");
                    setExpiryNotificationsOpen(false);
                    navigate("medicines");
                  }}
                  className="block w-full px-4 py-3 text-left hover:bg-amber-50"
                >
                  <span className="block break-words font-semibold text-gray-900">
                    {medicine.name}
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-3 text-xs">
                    <span className="text-gray-500">
                      Stock: {medicine.stock} · Expires{" "}
                      {medicine.expirationDate}
                    </span>
                    <span className="shrink-0 font-semibold text-amber-700">
                      {getExpirationLabel(daysUntilExpiration)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ─── Sidebar Component ────────────────────────────────────────────────────
  const Sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-6 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-700 rounded-xl flex items-center justify-center">
            <PillIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold text-emerald-700 leading-tight">
              MediServe
            </h1>
            <p className="text-xs text-gray-400">Admin Panel</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.key}
            onClick={() => navigate(item.key)}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors ${
              currentPage === item.key
                ? "bg-emerald-50 text-emerald-700 font-semibold"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-100">
        <div className="flex items-center gap-3 px-4 py-3 mb-2">
          <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
            <UserIcon className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {user.email}
            </p>
            <p className="text-xs text-gray-400">Administrator</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-red-600 hover:bg-red-50 rounded-xl font-semibold text-sm transition-colors"
        >
          <LogOutIcon className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="admin-app h-dvh overflow-hidden bg-gray-50 text-gray-900 font-sans">
      {/* ── Toast Stack ── */}
      <div className="fixed top-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-anim-in break-words px-4 py-3 rounded-xl shadow-lg border text-sm font-semibold pointer-events-auto ${
              t.type === "error"
                ? "bg-red-50 border-red-200 text-red-800"
                : t.type === "warning"
                  ? "bg-amber-50 border-amber-200 text-amber-900"
                  : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>

      <div className="fixed right-6 top-4 z-40 hidden lg:block">
        {renderExpiryBell()}
      </div>

      <div className="flex h-full min-h-0 overflow-hidden">
        {/* ── Desktop Sidebar ── */}
        <aside className="hidden lg:flex h-full w-72 shrink-0 flex-col border-r border-gray-200 bg-white">
          {Sidebar}
        </aside>

        {/* ── Mobile Sidebar Overlay ── */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <div className="absolute left-0 top-0 h-full w-72 max-w-[calc(100vw-2rem)] bg-white shadow-2xl z-50 flex flex-col">
              {Sidebar}
            </div>
          </div>
        )}

        {/* ── Main Content ── */}
        <main className="h-full min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {/* Mobile Top Bar */}
          <div className="lg:hidden bg-white border-b border-gray-200 px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 sticky top-0 z-30">
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open admin navigation"
              className="shrink-0 p-2 rounded-xl hover:bg-gray-100 text-gray-600"
            >
              <MenuIcon className="w-6 h-6" />
            </button>
            <div className="flex min-w-0 items-center gap-2">
              <div className="w-7 h-7 shrink-0 bg-emerald-700 rounded-lg flex items-center justify-center">
                <PillIcon className="w-4 h-4 text-white" />
              </div>
              <span className="truncate font-bold text-emerald-700 text-base sm:text-lg">
                MediServe Admin
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {renderExpiryBell()}
              <button
                onClick={handleLogout}
                aria-label="Sign out"
                className="text-red-500 hover:text-red-700 p-2 rounded-xl hover:bg-red-50"
              >
                <LogOutIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* ════════════ DASHBOARD ════════════ */}
          {currentPage === "dashboard" && (
            <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">
                  Dashboard Overview
                </h1>
                <p className="text-gray-500">
                  Monitor pharmacy queue and operations in real time
                </p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
                {[
                  {
                    title: "Waiting Patients",
                    value: counts.waiting,
                    sub: `${entries.filter((e) => e.status === "waiting" && e.patientType === "pwd").length} Priority`,
                    icon: <UsersIcon className="w-6 h-6" />,
                  },
                  {
                    title: "Served Today",
                    value: counts.served,
                    sub: "Completed today",
                    icon: <ActivityIcon className="w-6 h-6" />,
                  },
                  {
                    title: "Available Medicines",
                    value: medicines.filter(isStockItemAvailable).length,
                    sub: `${medicines.length} total in inventory`,
                    icon: <BoxIcon className="w-6 h-6" />,
                  },
                  {
                    title: "Low Stock Items",
                    value: lowStockMeds.length,
                    sub: "Needs restocking",
                    icon: <AlertTriangleIcon className="w-6 h-6" />,
                  },
                ].map((stat, i) => (
                  <div
                    key={i}
                    className="bg-white rounded-2xl p-4 border border-emerald-100 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-11 h-11 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-sm">
                        {stat.icon}
                      </div>
                    </div>
                    <p className="text-gray-600 text-sm font-medium">
                      {stat.title}
                    </p>
                    <p className="text-4xl font-black text-gray-900 mt-1 mb-1">
                      {stat.value}
                    </p>
                    <p className="text-xs text-gray-500">{stat.sub}</p>
                  </div>
                ))}
              </div>

              {/* Medicine Dispensing Report */}
              <div className="bg-white rounded-3xl shadow-sm border border-emerald-100 overflow-hidden mb-6">
                <div className="px-6 py-5 border-b border-emerald-50">
                  <h2 className="text-xl font-bold text-gray-900">
                    Medicine Dispensing Report
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Filter dispensing records by time period, category, or
                    medicine
                  </p>
                </div>

                <div className="p-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-gray-600">
                        Time Period
                      </label>
                      <select
                        value={reportPeriod}
                        onChange={(e) =>
                          setReportPeriod(e.target.value as ReportPeriod)
                        }
                        className="w-full h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold focus:border-emerald-700 focus:outline-none"
                      >
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                        <option value="custom">Custom Date Range</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-bold text-gray-600">
                        Medicine Category
                      </label>
                      <select
                        value={reportCategory}
                        onChange={(e) => {
                          setReportCategory(e.target.value);
                          setReportMedicine("all");
                        }}
                        className="w-full h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold focus:border-emerald-700 focus:outline-none"
                      >
                        <option value="all">All Categories</option>
                        {MEDICINE_CATEGORIES.map((category) => (
                          <option key={category} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1 sm:col-span-2 xl:col-span-2">
                      <label className="text-xs font-bold text-gray-600">
                        Specific Medicine
                      </label>
                      <select
                        value={reportMedicine}
                        onChange={(e) => setReportMedicine(e.target.value)}
                        className="w-full h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold focus:border-emerald-700 focus:outline-none"
                      >
                        <option value="all">All Medicines</option>
                        {reportMedicineNames
                          .filter(
                            (name) =>
                              reportCategory === "all" ||
                              medicines.some(
                                (med) =>
                                  med.name === name &&
                                  med.type === reportCategory,
                              ),
                          )
                          .map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  {reportPeriod === "custom" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-600">
                          Start Date
                        </label>
                        <input
                          type="date"
                          value={reportStartDate}
                          onChange={(e) => setReportStartDate(e.target.value)}
                          className="w-full h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold focus:border-emerald-700 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-gray-600">
                          End Date
                        </label>
                        <input
                          type="date"
                          value={reportEndDate}
                          min={reportStartDate}
                          onChange={(e) => setReportEndDate(e.target.value)}
                          className="w-full h-11 px-3 rounded-xl border border-gray-200 bg-white text-sm font-semibold focus:border-emerald-700 focus:outline-none"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
                      <p className="text-sm text-gray-600 font-semibold">
                        Total Medicines Dispensed
                      </p>
                      <p className="text-3xl font-black text-emerald-700 mt-1">
                        {reportTotalUnits}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        Units released
                      </p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white p-4">
                      <p className="text-sm text-gray-600 font-semibold">
                        Total Transactions
                      </p>
                      <p className="text-3xl font-black text-gray-900 mt-1">
                        {reportEntries.length}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        Dispensing records
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-2xl border border-emerald-100">
                    <table className="min-w-[320px] w-full">
                      <thead>
                        <tr className="bg-emerald-50 border-b border-emerald-100">
                          <th className="px-4 py-3 text-left text-xs font-bold text-gray-600 uppercase">
                            Medicine
                          </th>
                          <th className="px-4 py-3 text-right text-xs font-bold text-gray-600 uppercase">
                            Quantity Given
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-50">
                        {reportProductTotals.length === 0 ? (
                          <tr>
                            <td
                              colSpan={2}
                              className="px-4 py-8 text-center text-sm text-gray-400"
                            >
                              {reportHistoryLoading
                                ? "Loading dispensing records..."
                                : "No dispensing records match the filters"}
                            </td>
                          </tr>
                        ) : (
                          reportProductTotals.map((item) => (
                            <tr
                              key={item.name}
                              className="hover:bg-emerald-50/40"
                            >
                              <td className="break-words px-4 py-3 text-sm font-semibold text-gray-800">
                                {item.name}
                              </td>
                              <td className="px-4 py-3 text-right text-sm font-bold text-emerald-700">
                                {item.quantity}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6">
                {/* Recent Activity */}
                <div className="bg-white rounded-3xl shadow-sm border border-emerald-100 overflow-hidden">
                  <div className="flex flex-col min-[420px]:flex-row min-[420px]:items-center justify-between gap-3 px-4 sm:px-6 py-5 border-b border-emerald-50">
                    <h2 className="text-xl font-bold text-gray-900">
                      Recent Activity
                    </h2>
                    <button
                      onClick={() => navigate("queue")}
                      className="flex items-center gap-2 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-xl font-semibold text-sm"
                    >
                      View All <ArrowRightIcon className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="divide-y divide-emerald-50">
                    {entries.length === 0 ? (
                      <p className="text-center py-8 text-gray-400">
                        No recent activity
                      </p>
                    ) : (
                      [...entries]
                        .sort(
                          (a, b) =>
                            new Date(b.timestamp).getTime() -
                            new Date(a.timestamp).getTime(),
                        )
                        .slice(0, 5)
                        .map((entry) => {
                          const sc = STATUS_CONFIG[entry.status];
                          return (
                            <div
                              key={entry.id}
                              className="px-4 sm:px-6 py-4 hover:bg-emerald-50/60 transition-colors flex items-center justify-between gap-3"
                            >
                              <div className="flex min-w-0 items-center gap-4">
                                <div
                                  className={`w-3 h-3 rounded-full ${sc.dot}`}
                                />
                                <div className="min-w-0">
                                  <p className="break-words font-bold text-lg">
                                    {entry.queueNumber}
                                  </p>
                                  <p className="break-words text-gray-600 text-sm">
                                    {entry.patientName}
                                  </p>
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="text-xs text-gray-400">
                                  {new Date(entry.timestamp).toLocaleTimeString(
                                    [],
                                    { hour: "2-digit", minute: "2-digit" },
                                  )}
                                </p>
                                <span
                                  className={`inline-block px-3 py-1 text-xs font-semibold rounded-full mt-1 border ${sc.badge}`}
                                >
                                  {sc.label}
                                </span>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>
                </div>
              </div>

              {/* System status */}
              <div className="mt-6 p-4 sm:p-6 bg-emerald-50 border border-emerald-100 rounded-3xl flex items-start sm:items-center gap-4">
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                <div className="min-w-0">
                  <p className="font-bold text-emerald-700">
                    System Status — All systems operational
                  </p>
                  <p className="text-xs text-gray-400">
                    Real-time Firestore sync active ·{" "}
                    {new Date().toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ════════════ QUEUE PAGE ════════════ */}
          {currentPage === "queue" && (
            <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">
                    Live Queue Monitoring
                  </h1>
                  <p className="text-gray-500">
                    {counts.waiting} waiting · {counts.served} served today
                  </p>
                </div>
              </div>
              {getReadyEntry && (
                <div
                  role="status"
                  className="mb-6 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    Queue {formatQueueDisplay(getReadyEntry.queueNumber)} (
                    {getReadyEntry.patientName}) is currently in &quot;Get
                    Ready&quot;. Mark them as Served before setting another
                    patient to Get Ready.
                  </div>
                  <div className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 bg-orange-100 border border-orange-300 rounded-lg font-bold text-orange-900 text-xs">
                    <ClockIcon className="w-3.5 h-3.5" />
                    <span>
                      Auto-archives in:{" "}
                      {formatRemainingTime(
                        getReadyRemainingMs(getReadyEntry, currentTimeMs),
                      )}
                    </span>
                  </div>
                </div>
              )}

              {/* Filter Tabs */}
              <div className="flex flex-wrap gap-2 mb-6">
                {(
                  [
                    "all",
                    "waiting",
                    "processing",
                    "getready",
                    "served",
                    "archived",
                  ] as QueueFilter[]
                ).map((key) => (
                  <button
                    key={key}
                    onClick={() => setQueueFilter(key)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                      queueFilter === key
                        ? "bg-emerald-700 text-white shadow-md"
                        : "bg-white border border-gray-200 text-gray-600 hover:border-emerald-700"
                    }`}
                  >
                    {key === "all"
                      ? "Active Queue"
                      : (STATUS_CONFIG[key as keyof typeof STATUS_CONFIG]
                          ?.label ?? key)}
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full ${queueFilter === key ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"}`}
                    >
                      {counts[key]}
                    </span>
                  </button>
                ))}
              </div>

              {filteredEntries.length === 0 ? (
                <div className="bg-white border border-emerald-100 rounded-2xl p-16 text-center shadow-sm">
                  <UsersIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500 text-lg font-medium">
                    No patients in this category
                  </p>
                </div>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden 2xl:block bg-white border border-emerald-100 rounded-2xl overflow-x-auto shadow-sm">
                    <table className="min-w-[900px] w-full">
                      <thead>
                        <tr className="bg-emerald-50 border-b border-emerald-100">
                          {[
                            "Queue #",
                            "Patient",
                            "Type",
                            "Medicines",
                            "Status",
                            "Time",
                          ].map((h) => (
                            <th
                              key={h}
                              className="px-6 py-4 text-sm font-bold text-gray-600 uppercase text-left"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-50">
                        {filteredEntries.map((entry) => {
                          const sc = STATUS_CONFIG[entry.status];
                          const isPWD = entry.patientType === "pwd";
                          return (
                            <tr
                              key={entry.id}
                              role={
                                entry.status === "served" ||
                                entry.status === "archived"
                                  ? undefined
                                  : "button"
                              }
                              tabIndex={
                                entry.status === "served" ||
                                entry.status === "archived"
                                  ? undefined
                                  : 0
                              }
                              className={`${entry.status === "served" || entry.status === "archived" ? "cursor-default" : "hover:bg-emerald-50/40 cursor-pointer focus:outline-none focus:bg-emerald-50"} ${isPWD ? "bg-blue-50/20" : ""}`}
                              onClick={() => openQueueEntry(entry)}
                              onKeyDown={(event) => {
                                if (
                                  entry.status === "served" ||
                                  entry.status === "archived"
                                )
                                  return;
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  openQueueEntry(entry);
                                }
                              }}
                            >
                              <td className="px-6 py-4">
                                <span
                                  className={`text-xl font-black ${isPWD ? "text-blue-700" : "text-emerald-700"}`}
                                >
                                  {entry.queueNumber}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <p className="font-semibold text-gray-900">
                                  {entry.patientName}
                                </p>
                                <p className="text-gray-500 text-sm truncate max-w-xs">
                                  {entry.address}
                                </p>
                              </td>
                              <td className="px-6 py-4">
                                <span
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${isPWD ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-gray-100 text-gray-700 border-gray-200"}`}
                                >
                                  {isPWD ? (
                                    <AccessibilityIcon className="w-3 h-3" />
                                  ) : (
                                    <UserIcon className="w-3 h-3" />
                                  )}
                                  {isPWD ? "PWD" : "Regular"}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <div className="space-y-1">
                                  {entry.medicines.map((med, i) => (
                                    <div key={i} className="text-sm">
                                      <span className="text-gray-800 font-medium">
                                        {med}
                                      </span>
                                      <span className="text-gray-500">
                                        {" "}
                                        ×{entry.quantities[i] ?? 1}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${sc.badge}`}
                                >
                                  <span
                                    className={`w-2 h-2 rounded-full ${sc.dot}`}
                                  />
                                  {entry.status === "archived" &&
                                  entry.archivedReason === "no_show"
                                    ? "Archived (No Show)"
                                    : sc.label}
                                </span>
                                {entry.status === "getready" && (
                                  <span className="block mt-1 text-xs font-bold text-orange-600">
                                    ⏱{" "}
                                    {formatRemainingTime(
                                      getReadyRemainingMs(entry, currentTimeMs),
                                    )}{" "}
                                    left
                                  </span>
                                )}
                              </td>
                              <td className="px-6 py-4 text-gray-500 text-sm font-medium">
                                {new Date(entry.timestamp).toLocaleTimeString(
                                  [],
                                  { hour: "2-digit", minute: "2-digit" },
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Cards */}
                  <div className="2xl:hidden space-y-3">
                    {filteredEntries.map((entry) => {
                      const sc = STATUS_CONFIG[entry.status];
                      const isPWD = entry.patientType === "pwd";
                      return (
                        <div
                          key={entry.id}
                          role={
                            entry.status === "served" ||
                            entry.status === "archived"
                              ? undefined
                              : "button"
                          }
                          tabIndex={
                            entry.status === "served" ||
                            entry.status === "archived"
                              ? undefined
                              : 0
                          }
                          className={`bg-white border border-emerald-100 rounded-2xl p-4 sm:p-5 shadow-sm ${entry.status === "served" || entry.status === "archived" ? "cursor-default" : "cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500"}`}
                          onClick={() => openQueueEntry(entry)}
                          onKeyDown={(event) => {
                            if (
                              entry.status === "served" ||
                              entry.status === "archived"
                            )
                              return;
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              openQueueEntry(entry);
                            }
                          }}
                        >
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div className="min-w-0">
                              <span
                                className={`break-words text-2xl font-black ${isPWD ? "text-blue-800" : "text-emerald-700"}`}
                              >
                                {entry.queueNumber}
                              </span>
                              {isPWD && (
                                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full font-semibold">
                                  Priority
                                </span>
                              )}
                            </div>
                            <div className="shrink-0 flex flex-col items-end gap-1">
                              <span
                                className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${sc.badge}`}
                              >
                                {entry.status === "archived" &&
                                entry.archivedReason === "no_show"
                                  ? "Archived (No Show)"
                                  : sc.label}
                              </span>
                              {entry.status === "getready" && (
                                <span className="text-xs font-bold text-orange-600">
                                  ⏱{" "}
                                  {formatRemainingTime(
                                    getReadyRemainingMs(entry, currentTimeMs),
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="break-words font-semibold text-gray-900">
                            {entry.patientName}
                          </p>
                          <p className="break-words text-gray-500 text-sm mb-3">
                            {entry.address}
                          </p>
                          <div className="flex flex-wrap gap-1.5 mb-4">
                            {entry.medicines.map((m, i) => (
                              <span
                                key={i}
                                className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full border border-emerald-200 font-medium"
                              >
                                {m} ×{entry.quantities[i] ?? 1}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════════════ MEDICINES PAGE ════════════ */}
          {currentPage === "medicines" && (
            <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">
                    Medicine Inventory
                  </h1>
                  <p className="text-gray-500">
                    {medicines.length} total ·{" "}
                    {medicines.filter(isStockItemAvailable).length} available ·{" "}
                    {lowStockMeds.length} low stock · {expiringMedicines.length}{" "}
                    expiring within 5 days
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <p className="text-sm font-semibold text-gray-700 mb-3">
                  Medicine Categories
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setMedicineTypeFilter("all")}
                    className={`min-h-20 px-4 py-3 rounded-xl border text-left transition-colors ${
                      medicineTypeFilter === "all"
                        ? "bg-emerald-700 border-emerald-700 text-white"
                        : "bg-white border-emerald-200 text-gray-800 hover:border-emerald-400"
                    }`}
                  >
                    <span className="font-bold">All Categories</span>
                    <span
                      className={`block text-sm mt-1 ${medicineTypeFilter === "all" ? "text-emerald-100" : "text-gray-500"}`}
                    >
                      {medicines.length} medicines
                    </span>
                  </button>
                  {medicineTypes.map((category) => {
                    const count = medicines.filter(
                      (med) => med.type.trim() === category,
                    ).length;
                    const selected = medicineTypeFilter === category;
                    return (
                      <div
                        key={category}
                        className={`min-h-20 rounded-xl border transition-colors flex items-stretch ${
                          selected
                            ? "bg-emerald-50 border-emerald-700"
                            : "bg-white border-emerald-200"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setMedicineTypeFilter(category)}
                          className="flex-1 px-4 py-3 text-left"
                        >
                          <span className="font-bold text-gray-900 leading-tight block">
                            {category}
                          </span>
                          <span className="text-sm text-gray-500 mt-1 block">
                            {count} medicines
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openAddMed(category)}
                          title={`Add medicine to ${category}`}
                          className="m-2 w-10 h-10 self-center rounded-lg border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-700 hover:text-white flex items-center justify-center"
                        >
                          <PlusIcon className="w-5 h-5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {lowStockMeds.length > 0 && (
                <div className="mb-6 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <AlertTriangleIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-amber-900 font-semibold">
                      Low Stock Alert
                    </p>
                    <p className="text-amber-700 text-sm">
                      {lowStockMeds.map((m) => m.name).join(", ")} — please
                      restock soon.
                    </p>
                  </div>
                </div>
              )}

              {/* Stock Color Coding Legend */}
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 bg-white border border-emerald-100 rounded-2xl px-4 py-3 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Stock Color Coding
                </span>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <div className="inline-flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-emerald-600 ring-2 ring-emerald-100" />
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                      Old Stock
                    </span>
                    <span className="text-gray-600 text-xs">
                      Current active batch (dispensed first)
                    </span>
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-blue-600 ring-2 ring-blue-100" />
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-300">
                      New Stock
                    </span>
                    <span className="text-gray-600 text-xs">
                      Newly added / replacement stock (auto-replaces Old Stock at 0)
                    </span>
                  </div>
                </div>
              </div>

              {/* Desktop Table */}
              <div className="hidden 2xl:block bg-white border border-emerald-100 rounded-2xl overflow-x-auto shadow-sm">
                <table className="min-w-[1000px] w-full">
                  <thead>
                    <tr className="bg-emerald-50 border-b border-emerald-100">
                      {[
                        "Medicine Name",
                        "Category",
                        "Quantity",
                        "Status",
                        "Expiration",
                        "Availability",
                        "Actions",
                      ].map((h) => (
                        <th
                          key={h}
                          className={`px-6 py-4 text-sm font-bold text-gray-600 uppercase ${h === "Actions" ? "text-right" : "text-left"}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-50">
                    {filteredMedicines.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="text-center py-16 text-gray-400"
                        >
                          {medicines.length === 0
                            ? "No medicines. Add one to get started."
                            : "No medicines match this type."}
                        </td>
                      </tr>
                    ) : (
                      filteredMedicines.map((med) => {
                        const medicineAvailable = isStockItemAvailable(med);
                        const stockStatus = getStockStatus(
                          med.stock,
                          medicineAvailable,
                        );
                        const stockColor = stockStatus.color;
                        const stockLabel = stockStatus.label;
                        const daysUntilExpiration =
                          med.expirationDate && expiryToday
                            ? getDaysUntilExpiration(
                                med.expirationDate,
                                expiryToday,
                              )
                            : null;
                        const batchInfo = getStockBatchInfo(med, medicines);
                        const isNewBatch = batchInfo.role === "new";
                        return (
                          <tr
                            key={med.id}
                            data-medicine-id={med.id}
                            className={`scroll-mt-24 transition-colors border-l-4 ${
                              focusedMedicine?.id === med.id
                                ? "bg-amber-100 outline outline-2 outline-amber-400 border-l-amber-500"
                                : isNewBatch
                                  ? "border-l-blue-600 bg-blue-50/40 hover:bg-blue-50/70"
                                  : "border-l-emerald-600 bg-emerald-50/20 hover:bg-emerald-50/50"
                            }`}
                          >
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-4">
                                <div
                                  className={`w-11 h-11 rounded-xl flex items-center justify-center border ${
                                    isNewBatch
                                      ? "bg-blue-100 border-blue-300"
                                      : "bg-emerald-50 border-emerald-200"
                                  }`}
                                >
                                  <BoxIcon
                                    className={`w-5 h-5 ${
                                      isNewBatch
                                        ? "text-blue-700"
                                        : "text-emerald-700"
                                    }`}
                                  />
                                </div>
                                <div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p
                                      className={`font-semibold ${
                                        isNewBatch
                                          ? "text-blue-950"
                                          : "text-gray-900"
                                      }`}
                                    >
                                      {med.name}
                                    </p>
                                    <span
                                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                                        isNewBatch
                                          ? "bg-blue-100 text-blue-800 border-blue-300"
                                          : "bg-emerald-100 text-emerald-800 border-emerald-300"
                                      }`}
                                    >
                                      {isNewBatch ? "New Stock" : "Old Stock"}
                                    </span>
                                  </div>
                                  {med.batchNumber && (
                                    <p className="text-xs text-gray-500 mt-0.5">
                                      Batch: {med.batchNumber}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-gray-700 bg-gray-100 px-3 py-1 rounded-lg font-medium text-sm">
                                {med.type}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold border ${stockColor}`}
                              >
                                {med.stock}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span
                                className={`inline-flex px-3 py-1.5 rounded-full text-sm font-bold border ${stockColor}`}
                              >
                                {stockLabel}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-sm">
                              {med.expirationDate ? (
                                <div className="flex flex-col items-start gap-1">
                                  <span className="text-gray-700">
                                    {med.expirationDate}
                                  </span>
                                  {med.stock > 0 &&
                                    daysUntilExpiration !== null &&
                                    daysUntilExpiration <= 5 && (
                                      <span
                                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                          daysUntilExpiration < 0
                                            ? "bg-red-100 text-red-700"
                                            : "bg-amber-100 text-amber-800"
                                        }`}
                                      >
                                        {getExpirationLabel(
                                          daysUntilExpiration,
                                        )}
                                      </span>
                                    )}
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <button
                                onClick={() => handleToggleAvailable(med)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-semibold text-sm transition-colors ${
                                  medicineAvailable
                                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                                    : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"
                                }`}
                              >
                                <div
                                  className={`w-2 h-2 rounded-full ${medicineAvailable ? "bg-emerald-500" : "bg-gray-400"}`}
                                />
                                {medicineAvailable
                                  ? "Mark as Unavailable"
                                  : "Mark as Available"}
                              </button>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => openEditMed(med)}
                                  className="h-9 px-3 border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 font-semibold rounded-lg flex items-center"
                                >
                                  <EditIcon className="w-4 h-4 mr-1" /> Edit
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="2xl:hidden space-y-3">
                {filteredMedicines.length === 0 ? (
                  <div className="bg-white border border-emerald-100 rounded-2xl p-12 text-center">
                    <BoxIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-gray-500">
                      {medicines.length === 0
                        ? "No medicines yet."
                        : "No medicines match this type."}
                    </p>
                  </div>
                ) : (
                  filteredMedicines.map((med) => {
                    const medicineAvailable = isStockItemAvailable(med);
                    const stockStatus = getStockStatus(
                      med.stock,
                      medicineAvailable,
                    );
                    const stockColor = stockStatus.color;
                    const stockLabel = stockStatus.label;
                    const daysUntilExpiration =
                      med.expirationDate && expiryToday
                        ? getDaysUntilExpiration(
                            med.expirationDate,
                            expiryToday,
                          )
                        : null;
                    const batchInfo = getStockBatchInfo(med, medicines);
                    const isNewBatch = batchInfo.role === "new";
                    return (
                      <div
                        key={med.id}
                        data-medicine-id={med.id}
                        className={`scroll-mt-24 rounded-2xl p-5 shadow-sm transition-colors border-l-4 ${
                          focusedMedicine?.id === med.id
                            ? "border-amber-400 border-l-amber-500 bg-amber-50 ring-2 ring-amber-300 ring-offset-2"
                            : isNewBatch
                              ? "border border-blue-200 border-l-blue-600 bg-blue-50/40"
                              : "border border-emerald-200 border-l-emerald-600 bg-emerald-50/20"
                        }`}
                      >
                        <div className="flex items-start gap-4 mb-4">
                          <div
                            className={`w-11 h-11 rounded-xl flex items-center justify-center border ${
                              isNewBatch
                                ? "bg-blue-100 border-blue-300"
                                : "bg-emerald-50 border-emerald-200"
                            }`}
                          >
                            <BoxIcon
                              className={`w-5 h-5 ${
                                isNewBatch
                                  ? "text-blue-700"
                                  : "text-emerald-700"
                              }`}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p
                                className={`break-words font-bold ${
                                  isNewBatch ? "text-blue-950" : "text-gray-900"
                                }`}
                              >
                                {med.name}
                              </p>
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                                  isNewBatch
                                    ? "bg-blue-100 text-blue-800 border-blue-300"
                                    : "bg-emerald-100 text-emerald-800 border-emerald-300"
                                }`}
                              >
                                {isNewBatch ? "New Stock" : "Old Stock"}
                              </span>
                            </div>
                            <p className="break-words text-gray-500 text-sm">
                              {med.type}
                            </p>
                            {med.batchNumber && (
                              <p className="text-xs text-gray-500 mt-0.5">
                                Batch: {med.batchNumber}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <span
                              className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-bold border ${stockColor}`}
                            >
                              {med.stock}
                            </span>
                            <span
                              className={`text-xs font-bold ${stockColor.split(" ")[0]}`}
                            >
                              {stockLabel}
                            </span>
                          </div>
                        </div>
                        {med.expirationDate && (
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                            <span className="text-gray-600">
                              Expires {med.expirationDate}
                            </span>
                            {med.stock > 0 &&
                              daysUntilExpiration !== null &&
                              daysUntilExpiration <= 5 && (
                                <span
                                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                    daysUntilExpiration < 0
                                      ? "bg-red-100 text-red-700"
                                      : "bg-amber-100 text-amber-800"
                                  }`}
                                >
                                  {getExpirationLabel(daysUntilExpiration)}
                                </span>
                              )}
                          </div>
                        )}
                        <div className="flex flex-col min-[420px]:flex-row gap-2">
                          <button
                            onClick={() => handleToggleAvailable(med)}
                            className={`min-h-11 min-w-0 flex-1 break-words rounded-xl px-3 py-2 text-sm font-semibold border-2 transition-colors min-[420px]:h-10 min-[420px]:py-0 ${
                              medicineAvailable
                                ? "border-emerald-300 text-emerald-700 bg-emerald-50"
                                : "border-gray-300 text-gray-500"
                            }`}
                          >
                            {medicineAvailable
                              ? "Mark as Unavailable"
                              : "Mark as Available"}
                          </button>
                          <button
                            onClick={() => openEditMed(med)}
                            className="min-h-11 min-w-0 flex-1 border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 font-semibold rounded-xl flex items-center justify-center min-[420px]:h-10"
                          >
                            <EditIcon className="w-4 h-4 mr-1" /> Edit
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ════════════ QUEUE DETAIL MODAL ════════════ */}
      {modalOpen && selectedEntry && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 z-50 p-4"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col bg-white rounded-2xl shadow-xl modal-show"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 sm:px-6 py-5 border-b border-emerald-50 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
                  Patient Details
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Queue & requested medicines
                </p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="text-gray-400 hover:text-gray-700"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="min-h-0 p-4 sm:p-6 space-y-5 overflow-y-auto">
              {(() => {
                const entry = selectedEntry;
                const getReadyLockMessage =
                  getReadyEntry && getReadyEntry.id !== entry.id
                    ? `Queue ${formatQueueDisplay(getReadyEntry.queueNumber)} is currently in "Get Ready". Mark them as Served first.`
                    : undefined;
                const sc = STATUS_CONFIG[entry.status];
                const isPWD = entry.patientType === "pwd";
                return (
                  <>
                    <div
                      className={`rounded-2xl p-4 sm:p-6 text-center ${isPWD ? "bg-blue-50 border border-blue-200" : "bg-emerald-50 border border-emerald-200"}`}
                    >
                      <p className="text-gray-500 text-sm mb-1">Queue Number</p>
                      <p
                        className={`break-words text-[clamp(2rem,12vw,4.5rem)] font-black mb-3 ${isPWD ? "text-blue-700" : "text-emerald-700"}`}
                      >
                        {entry.queueNumber}
                      </p>
                      <div className="flex items-center justify-center gap-2">
                        {isPWD && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 text-blue-800 text-sm font-semibold border border-blue-200">
                            Priority
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
                      <div className="bg-gray-50 p-4 rounded-xl">
                        <p className="text-gray-400 text-xs mb-1">Name</p>
                        <p className="font-semibold text-sm">
                          {entry.patientName}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-xl">
                        <p className="text-gray-400 text-xs mb-1">Time</p>
                        <p className="font-semibold text-sm">
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>

                    <div className="bg-gray-50 p-4 rounded-xl">
                      <p className="text-gray-400 text-xs mb-1">Address</p>
                      <p className="font-semibold text-sm">{entry.address}</p>
                    </div>

                    {entry.phone && (
                      <div className="bg-gray-50 p-4 rounded-xl">
                        <p className="text-gray-400 text-xs mb-1">Phone</p>
                        <p className="font-semibold text-sm">{entry.phone}</p>
                      </div>
                    )}

                    <div className="bg-gray-50 p-4 rounded-xl">
                      <p className="text-gray-400 text-xs mb-2">
                        Medicines Requested
                      </p>
                      <div className="space-y-2">
                        {entry.medicines.map((med, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between bg-white px-4 py-2.5 rounded-lg border border-emerald-100"
                          >
                            <span className="font-semibold text-sm text-gray-900">
                              {med}
                            </span>
                            <span className="text-emerald-700 font-bold text-sm">
                              × {entry.quantities[i] ?? 1}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {entry.status === "archived" && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                        <p className="font-bold mb-1">Status: Archived</p>
                        <p>
                          {entry.archivedReason === "no_show"
                            ? "Patient did not show up within 15 minutes of being set to 'Get Ready'."
                            : "This queue entry has been moved to archive."}
                        </p>
                      </div>
                    )}

                    {entry.status === "getready" && (
                      <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800 flex items-center justify-between">
                        <span className="font-medium">Auto-archives in:</span>
                        <span className="font-bold text-orange-900">
                          {formatRemainingTime(
                            getReadyRemainingMs(entry, currentTimeMs),
                          )}
                        </span>
                      </div>
                    )}

                    <div className="space-y-2.5 pt-1">
                      {entry.status !== "getready" && (
                        <button
                          onClick={() => {
                            handleUpdateStatus(entry.id, "getready");
                            setModalOpen(false);
                          }}
                          disabled={
                            !!getReadyLockMessage ||
                            updatingQueueIds.has(entry.id)
                          }
                          title={getReadyLockMessage}
                          className="w-full h-12 bg-orange-500 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 text-white font-semibold rounded-xl flex items-center justify-center gap-2"
                        >
                          <BellIcon className="w-5 h-5" />
                          {updatingQueueIds.has(entry.id)
                            ? "Updating..."
                            : `Mark Get Ready ${entry.phone ? "& Send SMS" : ""}`}
                        </button>
                      )}
                      <div
                        className={`grid gap-2.5 ${entry.status === "processing" || entry.status === "getready" ? "grid-cols-1" : "grid-cols-1 min-[420px]:grid-cols-2"}`}
                      >
                        {entry.status !== "processing" &&
                          entry.status !== "getready" && (
                            <button
                              onClick={() => {
                                handleUpdateStatus(entry.id, "processing");
                                setModalOpen(false);
                              }}
                              className="h-11 border-2 border-blue-300 text-blue-700 hover:bg-blue-50 font-semibold rounded-xl"
                            >
                              Mark Processing
                            </button>
                          )}
                        {entry.status !== "served" && (
                          <button
                            onClick={() => {
                              handleUpdateStatus(entry.id, "served");
                              setModalOpen(false);
                            }}
                            disabled={updatingQueueIds.has(entry.id)}
                            className="h-11 bg-emerald-700 text-white font-semibold rounded-xl hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {updatingQueueIds.has(entry.id)
                              ? "Updating..."
                              : "Mark Served"}
                          </button>
                        )}
                      </div>
                      {entry.status === "getready" && (
                        <button
                          onClick={() => {
                            handleUpdateStatus(entry.id, "archived");
                            setModalOpen(false);
                          }}
                          disabled={updatingQueueIds.has(entry.id)}
                          className="w-full h-11 border-2 border-orange-300 text-orange-800 hover:bg-orange-50 font-semibold rounded-xl flex items-center justify-center gap-2"
                        >
                          <ArchiveIcon className="w-4 h-4" /> Move to Archive
                          (No Show)
                        </button>
                      )}
                      {entry.status === "archived" && (
                        <button
                          onClick={() => {
                            handleUpdateStatus(entry.id, "waiting");
                            setModalOpen(false);
                          }}
                          disabled={updatingQueueIds.has(entry.id)}
                          className="w-full h-11 border-2 border-emerald-300 text-emerald-800 hover:bg-emerald-50 font-semibold rounded-xl flex items-center justify-center gap-2"
                        >
                          Restore to Waiting
                        </button>
                      )}
                      <button
                        onClick={() =>
                          handleDeleteEntry(entry.id, entry.queueNumber)
                        }
                        className="w-full h-11 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 flex items-center justify-center gap-2"
                      >
                        <TrashIcon className="w-4 h-4" /> Remove from Queue
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ════════════ MEDICINE MODAL ════════════ */}
      {medModalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 z-50 p-2 sm:p-4"
          onClick={() => setMedModalOpen(false)}
        >
          <div
            className="w-full max-w-3xl max-h-[calc(100dvh-1rem)] sm:max-h-[90vh] overflow-y-auto overscroll-contain bg-white rounded-2xl shadow-xl modal-show"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 sm:px-6 py-5 border-b border-emerald-50 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">
                  {editingMed ? "Edit Medicine" : "Add New Medicine"}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {editingMed
                    ? "Update the details and save."
                    : "Fill out the details below."}
                </p>
              </div>
              <button
                onClick={() => setMedModalOpen(false)}
                className="text-gray-400 hover:text-gray-700"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleMedSubmit} className="p-4 sm:p-6 space-y-6">
              <section>
                <h3 className="text-lg font-bold text-gray-900 pb-3 border-b border-gray-100 mb-4">
                  Medicine Information
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Medicine Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={medForm.name}
                      onChange={(e) =>
                        setMedForm((p) => ({ ...p, name: e.target.value }))
                      }
                      required
                      placeholder="e.g., Paracetamol"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Generic Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={medForm.genericName}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          genericName: e.target.value,
                        }))
                      }
                      required
                      placeholder="e.g., Paracetamol"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Category <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={medForm.type}
                      onChange={(e) =>
                        setMedForm((p) => ({ ...p, type: e.target.value }))
                      }
                      required
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 bg-white focus:border-emerald-700 focus:outline-none text-base"
                    >
                      {MEDICINE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Dosage / Strength <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={medForm.dosageStrength}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          dosageStrength: e.target.value,
                        }))
                      }
                      required
                      placeholder="e.g., 500 mg"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Dosage Form <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={medForm.dosageForm}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          dosageForm: e.target.value,
                        }))
                      }
                      required
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 bg-white focus:border-emerald-700 focus:outline-none text-base"
                    >
                      <option value="">Select form</option>
                      {[
                        "Tablet",
                        "Capsule",
                        "Syrup",
                        "Suspension",
                        "Injection",
                        "Cream",
                        "Ointment",
                        "Drops",
                        "Inhaler",
                      ].map((form) => (
                        <option key={form} value={form}>
                          {form}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Unit of Measurement{" "}
                      <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={medForm.unitOfMeasurement}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          unitOfMeasurement: e.target.value,
                        }))
                      }
                      required
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 bg-white focus:border-emerald-700 focus:outline-none text-base"
                    >
                      <option value="">Select unit</option>
                      {[
                        "Piece",
                        "Tablet",
                        "Capsule",
                        "Bottle",
                        "Tube",
                        "Ampoule",
                        "Vial",
                        "Box",
                        "ml",
                        "L",
                      ].map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-lg font-bold text-gray-900 pb-3 border-b border-gray-100 mb-4">
                  Inventory Details
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Batch Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      value={medForm.batchNumber}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          batchNumber: e.target.value,
                        }))
                      }
                      required
                      placeholder="Enter batch number"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Initial Stock <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={medForm.stock}
                      required
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          stock: Math.max(0, parseInt(e.target.value) || 0),
                        }))
                      }
                      placeholder="Enter quantity"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Minimum Stock Level
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={medForm.minimumStock}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          minimumStock: Math.max(
                            0,
                            parseInt(e.target.value) || 0,
                          ),
                        }))
                      }
                      placeholder="e.g., 20"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Storage Location
                    </label>
                    <input
                      value={medForm.storageLocation}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          storageLocation: e.target.value,
                        }))
                      }
                      placeholder="e.g., Shelf A1"
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-lg font-bold text-gray-900 pb-3 border-b border-gray-100 mb-4">
                  Expiration Details
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Manufacturing Date
                    </label>
                    <input
                      type="date"
                      value={medForm.manufacturingDate}
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          manufacturingDate: e.target.value,
                        }))
                      }
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Expiration Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      value={medForm.expirationDate}
                      required
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          expirationDate: e.target.value,
                        }))
                      }
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Received Date <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="date"
                      value={medForm.receivedDate}
                      required
                      onChange={(e) =>
                        setMedForm((p) => ({
                          ...p,
                          receivedDate: e.target.value,
                        }))
                      }
                      className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base"
                    />
                  </div>
                </div>
              </section>

              <div className="flex flex-col-reverse min-[420px]:flex-row gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setMedModalOpen(false)}
                  className="flex-1 h-12 border-2 border-gray-200 text-gray-700 hover:bg-gray-50 rounded-xl font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={medLoading}
                  className="flex-1 h-12 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white rounded-xl font-semibold flex items-center justify-center gap-2"
                >
                  {medLoading && (
                    <SpinnerIcon className="w-4 h-4 animate-spin" />
                  )}
                  {editingMed ? "Save Medicine" : "Save Medicine"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline SVG Icons ──────────────────────────────────────────────────────────
function PillIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </svg>
  );
}
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}
function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function BoxIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function UserIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  );
}
function LogInIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </svg>
  );
}
function LogOutIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}
function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
function AlertCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function AlertTriangleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function ActivityIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function EditIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function MenuIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
function AccessibilityIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="16" cy="4" r="1" />
      <path d="m18 19 1-7-5.87.94" />
      <path d="M5 8l3-3 4 2 2 4-3 3" />
      <path d="m11.5 17.5-2 2.5H5" />
      <path d="m14 13.5 2.5 4.5H20" />
    </svg>
  );
}
function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}
