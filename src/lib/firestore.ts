/**
 * Firestore data types and CRUD helpers for MediServe
 *
 * Collections:
 *   customers        – all registered queue patients
 *   regular_patients – mirror for regular-type patients
 *   pwd_patients     – mirror for PWD-type patients
 *   orders           – one doc per queue entry (mirrors customers with order detail)
 *   stock            – medicine inventory
 */

import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp,
  type DocumentData,
  type QuerySnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StockItem {
  id: string;
  name: string;
  type: string;
  stock: number;
  available: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface QueueEntry {
  id: string;
  queueDate: string;
  queueNumber: string;
  patientName: string;
  address: string;
  phone?: string;
  patientType: "regular" | "pwd";
  seniorIdNumber?: string;
  medicines: string[];
  quantities: number[];
  status: "waiting" | "processing" | "getready" | "served" | "archived";
  timestamp: string; // ISO string for compat with existing UI
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// ─── Stock / Medicine helpers ─────────────────────────────────────────────────

export async function getStockItems(): Promise<StockItem[]> {
  const snap = await getDocs(collection(db, "stock"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as StockItem));
}

export function subscribeStockItems(
  cb: (items: StockItem[]) => void
): Unsubscribe {
  return onSnapshot(collection(db, "stock"), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StockItem)));
  });
}

export async function addStockItem(
  item: Omit<StockItem, "id">
): Promise<string> {
  const ref = await addDoc(collection(db, "stock"), {
    ...item,
    available: item.stock > 0 && item.available,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateStockItem(
  id: string,
  data: Partial<Omit<StockItem, "id">>
): Promise<void> {
  const normalizedData = data.stock !== undefined && data.stock <= 0
    ? { ...data, available: false }
    : data;
  await updateDoc(doc(db, "stock", id), {
    ...normalizedData,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteStockItem(id: string): Promise<void> {
  await deleteDoc(doc(db, "stock", id));
}

export async function deductStock(
  medicineName: string,
  qty: number
): Promise<void> {
  const snap = await getDocs(collection(db, "stock"));
  for (const d of snap.docs) {
    const data = d.data() as StockItem;
    if (data.name === medicineName) {
      const newStock = Math.max(0, (data.stock ?? 0) - qty);
      await updateDoc(doc(db, "stock", d.id), {
        stock: newStock,
        ...(newStock === 0 ? { available: false } : {}),
        updatedAt: serverTimestamp(),
      });
      break;
    }
  }
}

// ─── Queue / Order helpers ────────────────────────────────────────────────────

const QUEUE_TIME_ZONE = "Asia/Manila";

function getQueueDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: QUEUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function getQueueDateRange(queueDate: string): [Date, Date] {
  const start = new Date(`${queueDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return [start, end];
}

function snapToEntries(snap: QuerySnapshot<DocumentData>): QueueEntry[] {
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      queueDate: data.queueDate ?? "",
      queueNumber: data.queueNumber ?? "",
      patientName: data.patientName ?? "",
      address: data.address ?? "",
      phone: data.phone ?? "",
      patientType: data.patientType ?? "regular",
      seniorIdNumber: data.seniorIdNumber ?? "",
      medicines: data.medicines ?? [],
      quantities: data.quantities ?? [],
      status: data.status ?? "waiting",
      timestamp: data.timestamp ?? new Date().toISOString(),
    } as QueueEntry;
  });
}

export async function getQueueEntries(): Promise<QueueEntry[]> {
  const queueDate = getQueueDate();
  const [start, end] = getQueueDateRange(queueDate);
  const [dateTagged, legacy] = await Promise.all([
    getDocs(
      query(collection(db, "customers"), where("queueDate", "==", queueDate))
    ),
    getDocs(
      query(
        collection(db, "customers"),
        where("createdAt", ">=", Timestamp.fromDate(start)),
        where("createdAt", "<", Timestamp.fromDate(end))
      )
    ),
  ]);
  const entries = new Map(
    snapToEntries(dateTagged).map((entry) => [entry.id, entry])
  );
  for (const entry of snapToEntries(legacy)) {
    if (
      (!entry.queueDate || entry.queueDate === queueDate) &&
      !entries.has(entry.id)
    ) {
      entries.set(entry.id, entry);
    }
  }

  return [...entries.values()].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
  );
}

export function subscribeQueueEntries(
  cb: (entries: QueueEntry[]) => void
): Unsubscribe {
  let queueDate = getQueueDate();
  let dateEntries = new Map<string, QueueEntry>();
  let legacyEntries = new Map<string, QueueEntry>();
  let dateUnsubscribe: Unsubscribe = () => undefined;
  let legacyUnsubscribe: Unsubscribe = () => undefined;

  const publish = () => {
    const entries = new Map(dateEntries);
    for (const [id, entry] of legacyEntries) {
      if (!entries.has(id)) entries.set(id, entry);
    }
    cb(
      [...entries.values()].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      )
    );
  };

  const subscribeToDate = () => {
    dateUnsubscribe();
    legacyUnsubscribe();
    dateEntries = new Map();
    legacyEntries = new Map();

    const [start, end] = getQueueDateRange(queueDate);
    dateUnsubscribe = onSnapshot(
      query(
        collection(db, "customers"),
        where("queueDate", "==", queueDate)
      ),
      (snap) => {
        dateEntries = new Map(
          snapToEntries(snap).map((entry) => [entry.id, entry])
        );
        publish();
      },
      (error) => console.error("Could not subscribe to today's queue:", error)
    );
    legacyUnsubscribe = onSnapshot(
      query(
        collection(db, "customers"),
        where("createdAt", ">=", Timestamp.fromDate(start)),
        where("createdAt", "<", Timestamp.fromDate(end))
      ),
      (snap) => {
        legacyEntries = new Map(
          snapToEntries(snap)
            .filter((entry) => !entry.queueDate || entry.queueDate === queueDate)
            .map((entry) => [entry.id, entry])
        );
        publish();
      },
      (error) =>
        console.error("Could not subscribe to legacy queue entries:", error)
    );
  };

  subscribeToDate();
  const dateCheck = setInterval(() => {
    const currentDate = getQueueDate();
    if (currentDate !== queueDate) {
      queueDate = currentDate;
      subscribeToDate();
    }
  }, 30_000);

  return () => {
    clearInterval(dateCheck);
    dateUnsubscribe();
    legacyUnsubscribe();
  };
}

export async function getNextQueueNumber(
  patientType: QueueEntry["patientType"]
): Promise<{ queueDate: string; queueNumber: string }> {
  const response = await fetch("/api/queue/next-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientType }),
  });
  const result: unknown = await response.json();

  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    !("queueDate" in result) ||
    typeof result.queueDate !== "string" ||
    !("queueNumber" in result) ||
    typeof result.queueNumber !== "string"
  ) {
    const message =
      result &&
      typeof result === "object" &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "Could not allocate a queue number.";
    throw new Error(message);
  }

  return { queueDate: result.queueDate, queueNumber: result.queueNumber };
}

export async function addQueueEntry(
  entry: Omit<QueueEntry, "id">
): Promise<string> {
  const ref = await addDoc(collection(db, "customers"), {
    ...entry,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const typeCollection =
    entry.patientType === "pwd" ? "pwd_patients" : "regular_patients";

  await setDoc(doc(db, typeCollection, ref.id), {
    ...entry,
    customerId: ref.id,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await setDoc(doc(db, "orders", ref.id), {
    customerId: ref.id,
    queueNumber: entry.queueNumber,
    queueDate: entry.queueDate,
    patientName: entry.patientName,
    medicines: entry.medicines,
    quantities: entry.quantities,
    status: entry.status,
    patientType: entry.patientType,
    seniorIdNumber: entry.seniorIdNumber ?? "",
    timestamp: entry.timestamp,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  for (let i = 0; i < entry.medicines.length; i++) {
    await deductStock(entry.medicines[i], entry.quantities[i] ?? 1);
  }

  return ref.id;
}

export async function updateQueueEntryStatus(
  id: string,
  status: QueueEntry["status"]
): Promise<void> {
  await updateDoc(doc(db, "customers", id), {
    status,
    updatedAt: serverTimestamp(),
  });
  // Mirror to orders
  try {
    await updateDoc(doc(db, "orders", id), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch {
    // order doc may not exist
  }
}

export async function deleteQueueEntry(id: string): Promise<void> {
  const snap = await getDoc(doc(db, "customers", id));
  if (snap.exists()) {
    const data = snap.data() as QueueEntry;
    const typeCollection =
      data.patientType === "pwd" ? "pwd_patients" : "regular_patients";
    await deleteDoc(doc(db, typeCollection, id));
  }
  await deleteDoc(doc(db, "customers", id));
  try {
    await deleteDoc(doc(db, "orders", id));
  } catch {
    // ignore
  }
}
