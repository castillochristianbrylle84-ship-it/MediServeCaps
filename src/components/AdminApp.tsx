"use client";

import { useEffect, useState, useCallback } from "react";
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
  updateQueueEntryStatus,
  deleteQueueEntry,
  type StockItem,
  type QueueEntry,
} from "@/lib/firestore";

// Add this at the top of your app/admin/page.tsx file
export const dynamic = 'force-dynamic';

const CUSTOMER_APP_URL = process.env.NEXT_PUBLIC_CUSTOMER_URL || "/customer";

function hasAdminRole(claims: Record<string, unknown>) {
  return claims.admin === true || claims.role === "admin";
}

// ─── Types ────────────────────────────────────────────────────────────────────
type AdminPage = "dashboard" | "queue" | "medicines";
type QueueFilter = "all" | "waiting" | "processing" | "getready" | "served";

const STATUS_CONFIG = {
  waiting:    { label: "Waiting",    badge: "bg-amber-100 text-amber-800 border-amber-200",   dot: "bg-amber-400"   },
  processing: { label: "Processing", badge: "bg-blue-100 text-blue-800 border-blue-200",      dot: "bg-blue-500"    },
  getready:   { label: "Get Ready",  badge: "bg-orange-100 text-orange-800 border-orange-200",dot: "bg-orange-400"  },
  served:     { label: "Served",     badge: "bg-emerald-100 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
  archived:   { label: "Archived",   badge: "bg-gray-100 text-gray-800 border-gray-200", dot: "bg-gray-500" },
} as const;

// ─── Toast ───────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: string }[]>([]);
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
function LoginPage({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [showPw, setShowPw]     = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Login failed";
      if (msg.includes("invalid-credential") || msg.includes("wrong-password") || msg.includes("user-not-found")) {
        setError("Invalid email or password.");
      } else if (msg.includes("api-key-not-valid") || msg.includes("invalid-api-key")) {
        setError("Firebase rejected the API key. Check the web app config in your environment and restart the app.");
      } else if (msg.includes("operation-not-allowed")) {
        setError("Email/Password sign-in is disabled. Enable it in Firebase Authentication settings.");
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
          <h1 className="text-3xl font-extrabold text-emerald-700">MediServe Admin</h1>
          <p className="text-gray-500 mt-2 text-sm">City Health Pharmacy Management</p>
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
              <label className="text-sm font-semibold text-gray-700">Email Address</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                placeholder="Enter your email"
                className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-600 focus:outline-none text-base" />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-gray-700">Password</label>
              <div className="relative">
                <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} required
                  placeholder="Enter your password"
                  className="w-full h-12 px-4 pr-12 rounded-xl border border-gray-200 focus:border-emerald-600 focus:outline-none text-base" />
                <button type="button" onClick={() => setShowPw((p) => !p)}
                  className="absolute right-3 top-3 text-gray-400 hover:text-gray-600">
                  {showPw ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full h-12 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-bold rounded-xl text-base transition-colors flex items-center justify-center gap-2">
              {loading ? <SpinnerIcon className="w-5 h-5 animate-spin" /> : <LogInIcon className="w-5 h-5" />}
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Admin access only · No sign-up available
        </p>
        <div className="text-center mt-3">
          <a href={CUSTOMER_APP_URL} className="text-sm text-emerald-700 hover:underline"></a>
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
  const [user, setUser]             = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState<AdminPage>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Data
  const [medicines, setMedicines] = useState<StockItem[]>([]);
  const [entries, setEntries]     = useState<QueueEntry[]>([]);

  // Queue state
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const [selectedEntry, setSelectedEntry] = useState<QueueEntry | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Medicine modal state
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [editingMed, setEditingMed]     = useState<StockItem | null>(null);
  const [medForm, setMedForm] = useState({ name: "", type: "", stock: 0, available: true });
  const [medLoading, setMedLoading] = useState(false);
  const [medicineTypeFilter, setMedicineTypeFilter] = useState("all");

  // ─── Auth ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const unsub = onAuthStateChanged(auth, async (authenticatedUser) => {
      if (!authenticatedUser) {
        if (active) {
          setUser(null);
          setAuthLoading(false);
        }
        return;
      }

      try {
        const token = await authenticatedUser.getIdTokenResult();
        if (!hasAdminRole(token.claims)) {
          await signOut(auth);
          if (active) setUser(null);
        } else if (active) {
          setUser(authenticatedUser);
        }
      } catch {
        await signOut(auth);
        if (active) setUser(null);
      } finally {
        if (active) setAuthLoading(false);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  async function handleLogin(email: string, password: string): Promise<void> {
  const credential = await signInWithEmailAndPassword(
    auth,
    email,
    password
  );

  const token = await credential.user.getIdTokenResult(true);

  console.log("===== FIREBASE ADMIN TEST =====");
  console.log("UID:", credential.user.uid);
  console.log("Email:", credential.user.email);
  console.log("Claims:", token.claims);
  console.log("ADMIN:", token.claims.admin);
  console.log("ROLE:", token.claims.role);
  console.log("================================");

  if (!hasAdminRole(token.claims)) {
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
    return () => { unsubStock(); unsubQueue(); };
  }, [user]);

  // ─── Navigation ──────────────────────────────────────────────────────────
  function navigate(page: AdminPage) {
    setCurrentPage(page);
    setSidebarOpen(false);
  }

  // ─── Queue actions ────────────────────────────────────────────────────────
  async function handleUpdateStatus(id: string, status: QueueEntry["status"]) {
    const entry = entries.find((candidate) => candidate.id === id);
    try {
      await updateQueueEntryStatus(id, status);
    } catch {
      showToast("Failed to update status", "error");
      return;
    }

    if (status !== "getready" || !entry || entry.status === "getready") {
      showToast(`Status updated to ${STATUS_CONFIG[status].label}`);
      return;
    }
    if (!entry.phone) {
      showToast(`${entry.patientName} marked as Get Ready; no phone number is registered`);
      return;
    }

    try {
      if (!user) throw new Error("Admin session is unavailable.");
      const token = await user.getIdToken();
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;
      if (!apiBaseUrl && process.env.NEXT_PUBLIC_ADMIN_STATIC === "true") {
        throw new Error("Set VITE_API_BASE_URL for the standalone Admin deployment.");
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
          phoneNumber: entry.phone,
          message: `Hello ${entry.patientName} (Queue ${entry.queueNumber}), your turn is coming up soon! Please prepare to be called.`,
        }),
      });
      if (!response.ok) throw new Error(`SMS API returned HTTP ${response.status}.`);
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
  function openAddMed() {
    setEditingMed(null);
    setMedForm({ name: "", type: "", stock: 0, available: true });
    setMedModalOpen(true);
  }

  function openEditMed(med: StockItem) {
    setEditingMed(med);
    setMedForm({ name: med.name, type: med.type, stock: med.stock, available: med.available });
    setMedModalOpen(true);
  }

  async function handleMedSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!medForm.name.trim() || !medForm.type.trim()) {
      showToast("Please fill all required fields", "error");
      return;
    }
    setMedLoading(true);
    try {
      const medicineData = { ...medForm, available: medForm.stock > 0 };
      if (editingMed) {
        await updateStockItem(editingMed.id, medicineData);
        showToast("Medicine updated successfully");
      } else {
        await addStockItem(medicineData);
        showToast("Medicine added successfully");
      }
      setMedModalOpen(false);
    } catch {
      showToast("Failed to save medicine", "error");
    } finally {
      setMedLoading(false);
    }
  }

  async function handleDeleteMed(id: string, name: string) {
    if (!confirm(`Remove "${name}" from inventory?`)) return;
    try {
      await deleteStockItem(id);
      showToast("Medicine removed");
    } catch {
      showToast("Failed to remove medicine", "error");
    }
  }

  async function handleToggleAvailable(med: StockItem) {
    if (med.stock <= 0) {
      showToast("Restock this medicine before marking it available", "error");
      return;
    }
    try {
      await updateStockItem(med.id, { available: !med.available });
      showToast(!med.available ? "Medicine marked available" : "Medicine marked unavailable");
    } catch {
      showToast("Failed to update availability", "error");
    }
  }

  // ─── Computed values ──────────────────────────────────────────────────────
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.patientType === "pwd" && b.patientType !== "pwd") return -1;
    if (a.patientType !== "pwd" && b.patientType === "pwd") return 1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  const filteredEntries = queueFilter === "all"
    ? sortedEntries
    : sortedEntries.filter((e) => e.status === queueFilter);

  const counts = {
    all: entries.length,
    waiting: entries.filter((e) => e.status === "waiting").length,
    processing: entries.filter((e) => e.status === "processing").length,
    getready: entries.filter((e) => e.status === "getready").length,
    served: entries.filter((e) => e.status === "served").length,
  };

  const lowStockMeds = medicines.filter((m) => m.stock < 50);
  const medicineTypes = [...new Set(medicines.map((med) => med.type.trim()).filter(Boolean))].sort();
  const filteredMedicines = medicineTypeFilter === "all"
    ? medicines
    : medicines.filter((med) => med.type.trim() === medicineTypeFilter);

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
    { key: "dashboard", label: "Dashboard",         icon: <HomeIcon className="w-5 h-5" /> },
    { key: "queue",     label: "Queue Management",  icon: <UsersIcon className="w-5 h-5" /> },
    { key: "medicines", label: "Medicine Inventory",icon: <BoxIcon className="w-5 h-5" />  },
  ];

  // ─── Sidebar Component ────────────────────────────────────────────────────
  const Sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-6 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-700 rounded-xl flex items-center justify-center">
            <PillIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold text-emerald-700 leading-tight">MediServe</h1>
            <p className="text-xs text-gray-400">Admin Panel</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => (
          <button key={item.key} onClick={() => navigate(item.key)}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors ${
              currentPage === item.key
                ? "bg-emerald-50 text-emerald-700 font-semibold"
                : "text-gray-600 hover:bg-gray-100"
            }`}>
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
            <p className="text-sm font-semibold text-gray-900 truncate">{user.email}</p>
            <p className="text-xs text-gray-400">Administrator</p>
          </div>
        </div>
        <button onClick={handleLogout}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-red-600 hover:bg-red-50 rounded-xl font-semibold text-sm transition-colors">
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
    <div className="bg-gray-50 min-h-screen text-gray-900 font-sans">

      {/* ── Toast Stack ── */}
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id}
            className={`toast-anim-in px-4 py-3 rounded-xl shadow-lg border text-sm font-semibold pointer-events-auto ${
              t.type === "error" ? "bg-red-50 border-red-200 text-red-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}>{t.msg}</div>
        ))}
      </div>

      <div className="flex min-h-screen">

        {/* ── Desktop Sidebar ── */}
        <aside className="hidden lg:flex flex-col w-72 border-r border-gray-200 bg-white sticky top-0 h-screen">
          {Sidebar}
        </aside>

        {/* ── Mobile Sidebar Overlay ── */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
            <div className="absolute left-0 top-0 h-full w-72 bg-white shadow-2xl z-50 flex flex-col">
              {Sidebar}
            </div>
          </div>
        )}

        {/* ── Main Content ── */}
        <main className="flex-1 min-w-0">

          {/* Mobile Top Bar */}
          <div className="lg:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-30">
            <button onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-xl hover:bg-gray-100 text-gray-600">
              <MenuIcon className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-emerald-700 rounded-lg flex items-center justify-center">
                <PillIcon className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-emerald-700 text-lg">MediServe Admin</span>
            </div>
            <div className="ml-auto">
              <button onClick={handleLogout} className="text-red-500 hover:text-red-700 p-2 rounded-xl hover:bg-red-50">
                <LogOutIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* ════════════ DASHBOARD ════════════ */}
          {currentPage === "dashboard" && (
            <div className="p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-1">Dashboard Overview</h1>
                <p className="text-gray-500">Monitor pharmacy queue and operations in real time</p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {[
                  { title: "Waiting Patients", value: counts.waiting, sub: `${entries.filter((e) => e.status === "waiting" && e.patientType === "pwd").length} PWD priority`, icon: <UsersIcon className="w-6 h-6" /> },
                  { title: "Served Today",      value: counts.served,  sub: "Completed today", icon: <ActivityIcon className="w-6 h-6" /> },
                  { title: "Available Medicines",value: medicines.filter((m) => m.available).length, sub: `${medicines.length} total in inventory`, icon: <BoxIcon className="w-6 h-6" /> },
                  { title: "Low Stock Items",   value: lowStockMeds.length, sub: "Needs restocking", icon: <AlertTriangleIcon className="w-6 h-6" /> },
                ].map((stat, i) => (
                  <div key={i} className="bg-white rounded-2xl p-4 border border-emerald-100 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-3">
                      <div className="w-11 h-11 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-sm">
                        {stat.icon}
                      </div>
                    </div>
                    <p className="text-gray-600 text-sm font-medium">{stat.title}</p>
                    <p className="text-4xl font-black text-gray-900 mt-1 mb-1">{stat.value}</p>
                    <p className="text-xs text-gray-500">{stat.sub}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-6">
                {/* Recent Activity */}
                <div className="bg-white rounded-3xl shadow-sm border border-emerald-100 overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-5 border-b border-emerald-50">
                    <h2 className="text-xl font-bold text-gray-900">Recent Activity</h2>
                    <button onClick={() => navigate("queue")} className="flex items-center gap-2 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-xl font-semibold text-sm">
                      View All <ArrowRightIcon className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="divide-y divide-emerald-50">
                    {entries.length === 0
                      ? <p className="text-center py-8 text-gray-400">No recent activity</p>
                      : [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                          .slice(0, 5).map((entry) => {
                          const sc = STATUS_CONFIG[entry.status];
                          return (
                            <div key={entry.id} className="px-6 py-4 hover:bg-emerald-50/60 transition-colors flex items-center justify-between">
                              <div className="flex items-center gap-4">
                                <div className={`w-3 h-3 rounded-full ${sc.dot}`} />
                                <div>
                                  <p className="font-bold text-lg">{entry.queueNumber}</p>
                                  <p className="text-gray-600 text-sm">{entry.patientName}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className="text-xs text-gray-400">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                                <span className={`inline-block px-3 py-1 text-xs font-semibold rounded-full mt-1 border ${sc.badge}`}>{sc.label}</span>
                              </div>
                            </div>
                          );
                        })}
                  </div>
                </div>

              </div>

              {/* System status */}
              <div className="mt-6 p-6 bg-emerald-50 border border-emerald-100 rounded-3xl flex items-center gap-4">
                <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
                <div>
                  <p className="font-bold text-emerald-700">System Status — All systems operational</p>
                  <p className="text-xs text-gray-400">Real-time Firestore sync active · {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            </div>
          )}

          {/* ════════════ QUEUE PAGE ════════════ */}
          {currentPage === "queue" && (
            <div className="p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-1">Live Queue Monitoring</h1>
                  <p className="text-gray-500">{counts.waiting} waiting · {counts.served} served today</p>
                </div>
              </div>

              {/* Filter Tabs */}
              <div className="flex flex-wrap gap-2 mb-6">
                {(["all","waiting","processing","getready","served"] as QueueFilter[]).map((key) => (
                  <button key={key} onClick={() => setQueueFilter(key)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                      queueFilter === key
                        ? "bg-emerald-700 text-white shadow-md"
                        : "bg-white border border-gray-200 text-gray-600 hover:border-emerald-700"
                    }`}>
                    {key === "all" ? "All Patients" : STATUS_CONFIG[key as keyof typeof STATUS_CONFIG]?.label ?? key}
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${queueFilter === key ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"}`}>
                      {counts[key]}
                    </span>
                  </button>
                ))}
              </div>

              {filteredEntries.length === 0 ? (
                <div className="bg-white border border-emerald-100 rounded-2xl p-16 text-center shadow-sm">
                  <UsersIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500 text-lg font-medium">No patients in this category</p>
                </div>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden lg:block bg-white border border-emerald-100 rounded-2xl overflow-hidden shadow-sm">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-emerald-50 border-b border-emerald-100">
                          { ["Queue #","Patient","Type","Medicines","Status","Time"].map((h) => (
                            <th key={h} className="px-6 py-4 text-sm font-bold text-gray-600 uppercase text-left">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-50">
                        {filteredEntries.map((entry) => {
                          const sc = STATUS_CONFIG[entry.status];
                          const isPWD = entry.patientType === "pwd";
                          return (
                            <tr key={entry.id} className={`hover:bg-emerald-50/40 cursor-pointer ${isPWD ? "bg-blue-50/20" : ""}`}
                              onClick={() => { setSelectedEntry(entry); setModalOpen(true); }}>
                              <td className="px-6 py-4">
                                <span className={`text-xl font-black ${isPWD ? "text-blue-700" : "text-emerald-700"}`}>{entry.queueNumber}</span>
                              </td>
                              <td className="px-6 py-4">
                                <p className="font-semibold text-gray-900">{entry.patientName}</p>
                                <p className="text-gray-500 text-sm truncate max-w-xs">{entry.address}</p>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${isPWD ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-gray-100 text-gray-700 border-gray-200"}`}>
                                  {isPWD ? <AccessibilityIcon className="w-3 h-3" /> : <UserIcon className="w-3 h-3" />}
                                  {isPWD ? "PWD" : "Regular"}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <div className="space-y-1">
                                  {entry.medicines.map((med, i) => (
                                    <div key={i} className="text-sm">
                                      <span className="text-gray-800 font-medium">{med}</span>
                                      <span className="text-gray-500"> ×{entry.quantities[i] ?? 1}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${sc.badge}`}>
                                  <span className={`w-2 h-2 rounded-full ${sc.dot}`} /> {sc.label}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-gray-500 text-sm font-medium">
                                {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Cards */}
                  <div className="lg:hidden space-y-3">
                    {filteredEntries.map((entry) => {
                      const sc = STATUS_CONFIG[entry.status];
                      const isPWD = entry.patientType === "pwd";
                      return (
                        <div key={entry.id} className="bg-white border border-emerald-100 rounded-2xl p-5 shadow-sm cursor-pointer"
                          onClick={() => { setSelectedEntry(entry); setModalOpen(true); }}>
                          <div className="flex items-start justify-between mb-3">
                            <div>
                              <span className={`text-2xl font-black ${isPWD ? "text-blue-700" : "text-emerald-700"}`}>{entry.queueNumber}</span>
                              {isPWD && <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full font-semibold">PWD</span>}
                            </div>
                            <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${sc.badge}`}>{sc.label}</span>
                          </div>
                          <p className="font-semibold text-gray-900">{entry.patientName}</p>
                          <p className="text-gray-500 text-sm mb-3">{entry.address}</p>
                          <div className="flex flex-wrap gap-1.5 mb-4">
                            {entry.medicines.map((m, i) => (
                              <span key={i} className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full border border-emerald-200 font-medium">
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
            <div className="p-6 lg:p-8 max-w-7xl mx-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-1">Medicine Inventory</h1>
                  <p className="text-gray-500">{medicines.length} total · {medicines.filter((m) => m.available).length} available · {lowStockMeds.length} low stock</p>
                </div>
                <button onClick={openAddMed}
                  className="bg-emerald-700 hover:bg-emerald-800 text-white h-12 px-6 rounded-xl text-base font-semibold shadow-sm flex items-center">
                  <PlusIcon className="w-5 h-5 mr-2" /> Add Medicine
                </button>
              </div>

              <div className="mb-6 flex items-center gap-3">
                <label htmlFor="medicine-type-filter" className="text-sm font-semibold text-gray-700">Filter by Type</label>
                <select
                  id="medicine-type-filter"
                  value={medicineTypeFilter}
                  onChange={(e) => setMedicineTypeFilter(e.target.value)}
                  className="h-10 rounded-xl border border-emerald-200 bg-white px-3 text-sm font-semibold text-gray-700 focus:border-emerald-700 focus:outline-none"
                >
                  <option value="all">All Types</option>
                  {medicineTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>

              {lowStockMeds.length > 0 && (
                <div className="mb-6 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <AlertTriangleIcon className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-amber-900 font-semibold">Low Stock Alert</p>
                    <p className="text-amber-700 text-sm">{lowStockMeds.map((m) => m.name).join(", ")} — please restock soon.</p>
                  </div>
                </div>
              )}

              {/* Desktop Table */}
              <div className="hidden lg:block bg-white border border-emerald-100 rounded-2xl overflow-hidden shadow-sm">
                <table className="w-full">
                  <thead>
                    <tr className="bg-emerald-50 border-b border-emerald-100">
                      {["Medicine Name","Type","Quantity","Status","Availability","Actions"].map((h) => (
                        <th key={h} className={`px-6 py-4 text-sm font-bold text-gray-600 uppercase ${h === "Actions" ? "text-right" : "text-left"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-50">
                    {filteredMedicines.length === 0 ? (
                      <tr><td colSpan={6} className="text-center py-16 text-gray-400">{medicines.length === 0 ? "No medicines. Add one to get started." : "No medicines match this type."}</td></tr>
                    ) : filteredMedicines.map((med) => {
                      const stockColor = med.stock < 50 ? "text-red-600 bg-red-50 border-red-200" : med.stock < 100 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-emerald-700 bg-emerald-50 border-emerald-200";
                      const stockLabel = med.stock < 50 ? "Low Stock" : med.stock < 100 ? "Medium Stock" : "In Stock";
                      return (
                        <tr key={med.id} className="hover:bg-emerald-50/40">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-4">
                              <div className="w-11 h-11 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-center">
                                <BoxIcon className="w-5 h-5 text-emerald-700" />
                              </div>
                              <p className="font-semibold text-gray-900">{med.name}</p>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-gray-700 bg-gray-100 px-3 py-1 rounded-lg font-medium text-sm">{med.type}</span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold border ${stockColor}`}>
                              {med.stock}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex px-3 py-1.5 rounded-full text-sm font-bold border ${stockColor}`}>
                              {stockLabel}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <button onClick={() => handleToggleAvailable(med)}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border font-semibold text-sm transition-colors ${
                                med.available ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100" : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"
                              }`}>
                              <div className={`w-2 h-2 rounded-full ${med.available ? "bg-emerald-500" : "bg-gray-400"}`} />
                              {med.available ? "Available" : "Unavailable"}
                            </button>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex justify-end gap-2">
                              <button onClick={() => openEditMed(med)}
                                className="h-9 px-3 border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 font-semibold rounded-lg flex items-center">
                                <EditIcon className="w-4 h-4 mr-1" /> Edit
                              </button>
                              <button onClick={() => handleDeleteMed(med.id, med.name)}
                                className="h-9 w-9 bg-red-600 text-white rounded-lg flex items-center justify-center hover:bg-red-700">
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Cards */}
              <div className="lg:hidden space-y-3">
                {filteredMedicines.length === 0 ? (
                  <div className="bg-white border border-emerald-100 rounded-2xl p-12 text-center">
                    <BoxIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-gray-500">{medicines.length === 0 ? "No medicines yet." : "No medicines match this type."}</p>
                  </div>
                ) : filteredMedicines.map((med) => {
                  const stockColor = med.stock < 50 ? "text-red-600 bg-red-50 border-red-200" : med.stock < 100 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-emerald-700 bg-emerald-50 border-emerald-200";
                  const stockLabel = med.stock < 50 ? "Low Stock" : med.stock < 100 ? "Medium Stock" : "In Stock";
                  return (
                    <div key={med.id} className="bg-white border border-emerald-100 rounded-2xl p-5 shadow-sm">
                      <div className="flex items-start gap-4 mb-4">
                        <div className="w-11 h-11 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-center">
                          <BoxIcon className="w-5 h-5 text-emerald-700" />
                        </div>
                        <div className="flex-1">
                          <p className="font-bold text-gray-900">{med.name}</p>
                          <p className="text-gray-500 text-sm">{med.type}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-bold border ${stockColor}`}>
                            {med.stock}
                          </span>
                          <span className={`text-xs font-bold ${stockColor.split(" ")[0]}`}>{stockLabel}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleToggleAvailable(med)}
                          className={`flex-1 h-10 rounded-xl text-sm font-semibold border-2 transition-colors ${
                            med.available ? "border-emerald-300 text-emerald-700 bg-emerald-50" : "border-gray-300 text-gray-500"
                          }`}>
                          {med.available ? "✓ Available" : "Unavailable"}
                        </button>
                        <button onClick={() => openEditMed(med)}
                          className="flex-1 h-10 border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50 font-semibold rounded-xl flex items-center justify-center">
                          <EditIcon className="w-4 h-4 mr-1" /> Edit
                        </button>
                        <button onClick={() => handleDeleteMed(med.id, med.name)}
                          className="h-10 w-10 bg-red-600 text-white rounded-xl flex items-center justify-center hover:bg-red-700">
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </main>
      </div>

      {/* ════════════ QUEUE DETAIL MODAL ════════════ */}
      {modalOpen && selectedEntry && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 z-50 p-4" onClick={() => setModalOpen(false)}>
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl modal-show" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-emerald-50 flex items-start justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Patient Details</h2>
                <p className="text-sm text-gray-500 mt-1">Queue & requested medicines</p>
              </div>
              <button onClick={() => setModalOpen(false)} className="text-gray-400 hover:text-gray-700">
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
              {(() => {
                const entry = selectedEntry;
                const sc = STATUS_CONFIG[entry.status];
                const isPWD = entry.patientType === "pwd";
                return (
                  <>
                    <div className={`rounded-2xl p-6 text-center ${isPWD ? "bg-blue-50 border border-blue-200" : "bg-emerald-50 border border-emerald-200"}`}>
                      <p className="text-gray-500 text-sm mb-1">Queue Number</p>
                      <p className={`text-7xl font-black mb-3 ${isPWD ? "text-blue-700" : "text-emerald-700"}`}>{entry.queueNumber}</p>
                      <div className="flex items-center justify-center gap-2">
                        {isPWD && <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-100 text-blue-800 text-sm font-semibold border border-blue-200">PWD Priority</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-gray-50 p-4 rounded-xl">
                        <p className="text-gray-400 text-xs mb-1">Name</p>
                        <p className="font-semibold text-sm">{entry.patientName}</p>
                      </div>
                      <div className="bg-gray-50 p-4 rounded-xl">
                        <p className="text-gray-400 text-xs mb-1">Time</p>
                        <p className="font-semibold text-sm">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
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
                      <p className="text-gray-400 text-xs mb-2">Medicines Requested</p>
                      <div className="space-y-2">
                        {entry.medicines.map((med, i) => (
                          <div key={i} className="flex items-center justify-between bg-white px-4 py-2.5 rounded-lg border border-emerald-100">
                            <span className="font-semibold text-sm text-gray-900">{med}</span>
                            <span className="text-emerald-700 font-bold text-sm">× {entry.quantities[i] ?? 1}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2.5 pt-1">
                      <button onClick={() => { handleUpdateStatus(entry.id, "getready"); setModalOpen(false); }}
                        className="w-full h-12 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl flex items-center justify-center gap-2">
                        <BellIcon className="w-5 h-5" />
                        Mark Get Ready {entry.phone ? "& Send SMS" : ""}
                      </button>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button onClick={() => { handleUpdateStatus(entry.id, "processing"); setModalOpen(false); }}
                          className="h-11 border-2 border-blue-300 text-blue-700 hover:bg-blue-50 font-semibold rounded-xl">
                          Mark Processing
                        </button>
                        <button onClick={() => { handleUpdateStatus(entry.id, "served"); setModalOpen(false); }}
                          className="h-11 bg-emerald-700 text-white font-semibold rounded-xl hover:bg-emerald-800">
                          Mark Served
                        </button>
                      </div>
                      <button onClick={() => handleDeleteEntry(entry.id, entry.queueNumber)}
                        className="w-full h-11 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 flex items-center justify-center gap-2">
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
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 z-50 p-4" onClick={() => setMedModalOpen(false)}>
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl modal-show" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-emerald-50 flex items-start justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{editingMed ? "Edit Medicine" : "Add New Medicine"}</h2>
                <p className="text-sm text-gray-500 mt-1">{editingMed ? "Update the details and save." : "Fill out the details below."}</p>
              </div>
              <button onClick={() => setMedModalOpen(false)} className="text-gray-400 hover:text-gray-700">
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleMedSubmit} className="space-y-5 p-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-gray-800">Medicine Name <span className="text-red-500">*</span></label>
                <input value={medForm.name} onChange={(e) => setMedForm((p) => ({ ...p, name: e.target.value }))} required
                  placeholder="e.g., Paracetamol 500mg"
                  className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-gray-800">Type <span className="text-red-500">*</span></label>
                <input value={medForm.type} onChange={(e) => setMedForm((p) => ({ ...p, type: e.target.value }))} required
                  placeholder="e.g., Tablet, Capsule, Syrup"
                  className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-gray-800">Quantity</label>
                <input type="number" min="0" value={medForm.stock}
                  onChange={(e) => setMedForm((p) => ({ ...p, stock: Math.max(0, parseInt(e.target.value) || 0) }))}
                  className="w-full h-12 px-4 rounded-xl border border-gray-200 focus:border-emerald-700 focus:outline-none text-base" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setMedModalOpen(false)}
                  className="flex-1 h-12 border-2 border-gray-200 text-gray-700 hover:bg-gray-50 rounded-xl font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={medLoading}
                  className="flex-1 h-12 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white rounded-xl font-semibold flex items-center justify-center gap-2">
                  {medLoading && <SpinnerIcon className="w-4 h-4 animate-spin" />}
                  {editingMed ? "Update Medicine" : "Add Medicine"}
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
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/></svg>;
}
function HomeIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
}
function UsersIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function BoxIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;
}
function UserIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>;
}
function LogInIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>;
}
function LogOutIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
}
function ArrowLeftIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>;
}
function ArrowRightIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>;
}
function AlertCircleIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}
function AlertTriangleIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
}
function ActivityIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
}
function TrashIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
}
function EditIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
}
function PlusIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}
function XIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
}
function MenuIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>;
}
function AccessibilityIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-5.87.94"/><path d="M5 8l3-3 4 2 2 4-3 3"/><path d="m11.5 17.5-2 2.5H5"/><path d="m14 13.5 2.5 4.5H20"/></svg>;
}
function EyeIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>;
}
function EyeOffIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>;
}
function SpinnerIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>;
}
function BellIcon({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
}
