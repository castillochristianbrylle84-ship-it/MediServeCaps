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
  runTransaction,
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
  manualUnavailable?: boolean;
  genericName?: string;
  dosageStrength?: string;
  dosageForm?: string;
  unitOfMeasurement?: string;
  batchNumber?: string;
  minimumStock?: number;
  storageLocation?: string;
  manufacturingDate?: string;
  expirationDate?: string;
  receivedDate?: string;
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
  dispensedAt?: string;
  readyAt?: string;
  archivedAt?: string;
  archivedReason?: string;
  wasServed?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export const GET_READY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export function isGetReadyExpired(
  entry: Pick<QueueEntry, "status"> & {
    readyAt?: string;
    timestamp?: string;
    updatedAt?: Timestamp;
  },
  nowMs = Date.now()
): boolean {
  if (entry.status !== "getready") return false;
  const readyTime = entry.readyAt
    ? Date.parse(entry.readyAt)
    : entry.updatedAt instanceof Timestamp
      ? entry.updatedAt.toMillis()
      : entry.timestamp
        ? Date.parse(entry.timestamp)
        : 0;
  if (!readyTime || isNaN(readyTime)) return false;
  return nowMs - readyTime >= GET_READY_TIMEOUT_MS;
}

export function getReadyRemainingMs(
  entry: Pick<QueueEntry, "status"> & {
    readyAt?: string;
    timestamp?: string;
    updatedAt?: Timestamp;
  },
  nowMs = Date.now()
): number {
  if (entry.status !== "getready") return 0;
  const readyTime = entry.readyAt
    ? Date.parse(entry.readyAt)
    : entry.updatedAt instanceof Timestamp
      ? entry.updatedAt.toMillis()
      : entry.timestamp
        ? Date.parse(entry.timestamp)
        : 0;
  if (!readyTime || isNaN(readyTime)) return 0;
  return Math.max(0, GET_READY_TIMEOUT_MS - (nowMs - readyTime));
}

// ─── Stock / Medicine helpers ─────────────────────────────────────────────────

function toStockItem(id: string, data: DocumentData): StockItem {
  const stock =
    typeof data.stock === "number" && Number.isFinite(data.stock)
      ? Math.max(0, data.stock)
      : 0;
  const manualUnavailable =
    data.manualUnavailable === true ||
    (data.manualUnavailable === undefined &&
      data.available === false &&
      stock > 0);

  return {
    ...data,
    id,
    stock,
    manualUnavailable,
    available: stock > 0 && data.available === true && !manualUnavailable,
  } as StockItem;
}

export function isStockItemAvailable(item: StockItem): boolean {
  return item.stock > 0 && item.available && item.manualUnavailable !== true;
}

export async function getStockItems(): Promise<StockItem[]> {
  const snap = await getDocs(collection(db, "stock"));
  return snap.docs.map((d) => toStockItem(d.id, d.data()));
}

export function subscribeStockItems(
  cb: (items: StockItem[]) => void
): Unsubscribe {
  return onSnapshot(collection(db, "stock"), (snap) => {
    cb(snap.docs.map((d) => toStockItem(d.id, d.data())));
  });
}

export async function addStockItem(
  item: Omit<StockItem, "id">
): Promise<string> {
  const ref = await addDoc(collection(db, "stock"), {
    ...item,
    stock: Number.isFinite(item.stock) ? Math.max(0, item.stock) : 0,
    manualUnavailable: item.manualUnavailable === true,
    available:
      item.stock > 0 &&
      Number.isFinite(item.stock) &&
      item.available &&
      item.manualUnavailable !== true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateStockItem(
  id: string,
  data: Partial<Omit<StockItem, "id">>
): Promise<void> {
  const stockRef = doc(db, "stock", id);
  await runTransaction(db, async (transaction) => {
    const stockSnap = await transaction.get(stockRef);
    if (!stockSnap.exists()) throw new Error("Medicine not found.");

    const currentData = stockSnap.data();
    const currentStock =
      typeof currentData.stock === "number" && Number.isFinite(currentData.stock)
        ? Math.max(0, currentData.stock)
        : 0;
    const currentManualUnavailable =
      currentData.manualUnavailable === true ||
      (currentData.manualUnavailable === undefined &&
        currentData.available === false &&
        currentStock > 0);
    const manualUnavailable =
      typeof data.manualUnavailable === "boolean"
        ? data.manualUnavailable
        : currentManualUnavailable;
    const stock =
      data.stock === undefined
        ? currentStock
        : Math.max(0, Number.isFinite(data.stock) ? data.stock : 0);

    transaction.update(stockRef, {
      ...data,
      stock,
      manualUnavailable,
      available: stock > 0 && !manualUnavailable,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function setStockItemAvailability(
  id: string,
  available: boolean
): Promise<void> {
  const stockRef = doc(db, "stock", id);
  await runTransaction(db, async (transaction) => {
    const stockSnap = await transaction.get(stockRef);
    if (!stockSnap.exists()) throw new Error("Medicine not found.");

    const stockData = stockSnap.data();
    const stock =
      typeof stockData.stock === "number" && Number.isFinite(stockData.stock)
        ? Math.max(0, stockData.stock)
        : 0;
    if (available && stock <= 0) {
      throw new Error("Restock this medicine before marking it available.");
    }

    transaction.update(stockRef, {
      manualUnavailable: !available,
      available,
      updatedAt: serverTimestamp(),
    });
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
      const currentStock =
        typeof data.stock === "number" && Number.isFinite(data.stock)
          ? Math.max(0, data.stock)
          : 0;
      const newStock = Math.max(0, currentStock - qty);
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
      dispensedAt:
        data.dispensedAt instanceof Timestamp
          ? data.dispensedAt.toDate().toISOString()
          : typeof data.dispensedAt === "string"
            ? data.dispensedAt
            : undefined,
      readyAt:
        data.readyAt instanceof Timestamp
          ? data.readyAt.toDate().toISOString()
          : typeof data.readyAt === "string"
            ? data.readyAt
            : data.status === "getready" && data.updatedAt instanceof Timestamp
              ? data.updatedAt.toDate().toISOString()
              : undefined,
      archivedAt:
        data.archivedAt instanceof Timestamp
          ? data.archivedAt.toDate().toISOString()
          : typeof data.archivedAt === "string"
            ? data.archivedAt
            : undefined,
      archivedReason:
        typeof data.archivedReason === "string" ? data.archivedReason : undefined,
      wasServed: data.wasServed === true,
      updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : undefined,
      createdAt: data.createdAt instanceof Timestamp ? data.createdAt : undefined,
    } as QueueEntry;
  });
}

export async function getQueueEntry(id: string): Promise<QueueEntry | null> {
  const snap = await getDoc(doc(db, "customers", id));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
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
    dispensedAt:
      data.dispensedAt instanceof Timestamp
        ? data.dispensedAt.toDate().toISOString()
        : typeof data.dispensedAt === "string"
          ? data.dispensedAt
          : undefined,
    readyAt:
      data.readyAt instanceof Timestamp
        ? data.readyAt.toDate().toISOString()
        : typeof data.readyAt === "string"
          ? data.readyAt
          : data.status === "getready" && data.updatedAt instanceof Timestamp
            ? data.updatedAt.toDate().toISOString()
            : undefined,
    archivedAt:
      data.archivedAt instanceof Timestamp
        ? data.archivedAt.toDate().toISOString()
        : typeof data.archivedAt === "string"
          ? data.archivedAt
          : undefined,
    archivedReason:
      typeof data.archivedReason === "string" ? data.archivedReason : undefined,
    wasServed: data.wasServed === true,
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : undefined,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : undefined,
  } as QueueEntry;
}

export async function getQueueEntriesForDateRange(
  startDate: string,
  endDate: string
): Promise<QueueEntry[]> {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const [dateTagged, timestamped] = await Promise.all([
    getDocs(
      query(
        collection(db, "customers"),
        where("queueDate", ">=", startDate),
        where("queueDate", "<=", endDate)
      )
    ),
    getDocs(
      query(
        collection(db, "customers"),
        where("timestamp", ">=", start.toISOString()),
        where("timestamp", "<", end.toISOString())
      )
    ),
  ]);
  const entries = new Map(
    snapToEntries(dateTagged).map((entry) => [entry.id, entry])
  );
  for (const entry of snapToEntries(timestamped)) {
    entries.set(entry.id, entry);
  }
  return [...entries.values()];
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

  return ref.id;
}

export async function updateQueueEntryStatus(
  id: string,
  status: QueueEntry["status"],
  metadata?: { archivedReason?: string }
): Promise<void> {
  const customerRef = doc(db, "customers", id);
  const activeQueueRefs =
    status === "getready"
      ? (await getQueueEntries())
          .filter(
            (entry) =>
              entry.id !== id &&
              !entry.wasServed &&
              entry.status !== "served" &&
              entry.status !== "archived"
          )
          .map((entry) => doc(db, "customers", entry.id))
      : [];

  if (status !== "served") {
    await runTransaction(db, async (transaction) => {
      const [customerSnap, ...activeQueueSnapshots] = await Promise.all([
        transaction.get(customerRef),
        ...activeQueueRefs.map((entryRef) => transaction.get(entryRef)),
      ]);
      if (!customerSnap.exists()) throw new Error("Queue entry not found.");

      if (status === "getready") {
        const alreadyReady = activeQueueSnapshots.find(
          (entrySnap) =>
            entrySnap.exists() &&
            entrySnap.get("status") === "getready" &&
            entrySnap.get("wasServed") !== true
        );
        if (alreadyReady) {
          const readyAtVal = alreadyReady.get("readyAt");
          const updatedAtVal = alreadyReady.get("updatedAt");
          const timestampVal = alreadyReady.get("timestamp");
          const readyTime =
            readyAtVal instanceof Timestamp
              ? readyAtVal.toMillis()
              : typeof readyAtVal === "string"
                ? Date.parse(readyAtVal)
                : updatedAtVal instanceof Timestamp
                  ? updatedAtVal.toMillis()
                  : typeof timestampVal === "string"
                    ? Date.parse(timestampVal)
                    : 0;
          const isExpired =
            readyTime > 0 && Date.now() - readyTime >= GET_READY_TIMEOUT_MS;

          if (isExpired) {
            // Auto-archive the expired ready entry right in this transaction!
            const expiredPatientType =
              alreadyReady.get("patientType") === "pwd"
                ? "pwd_patients"
                : "regular_patients";
            const archiveUpdate = {
              status: "archived",
              archivedAt: serverTimestamp(),
              archivedReason: "no_show",
              updatedAt: serverTimestamp(),
            };
            transaction.update(alreadyReady.ref, archiveUpdate);
            transaction.set(
              doc(db, expiredPatientType, alreadyReady.id),
              archiveUpdate,
              { merge: true }
            );
            transaction.set(
              doc(db, "orders", alreadyReady.id),
              archiveUpdate,
              { merge: true }
            );
          } else {
            const queueNumber = alreadyReady.get("queueNumber") ?? "unknown";
            throw new Error(
              `Queue #${queueNumber} is currently in "Get Ready". Mark them as Served before setting another patient to Get Ready.`
            );
          }
        }
      }

      const customerData = customerSnap.data();
      const patientType = customerData.patientType === "pwd" ? "pwd_patients" : "regular_patients";
      const patientRef = doc(db, patientType, id);
      const orderRef = doc(db, "orders", id);

      const update: Record<string, unknown> = {
        status,
        updatedAt: serverTimestamp(),
        ...(status === "getready" ? { readyAt: serverTimestamp() } : {}),
        ...(status === "archived"
          ? {
              archivedAt: serverTimestamp(),
              archivedReason: metadata?.archivedReason ?? "no_show",
            }
          : {}),
      };
      transaction.update(customerRef, update);
      transaction.set(patientRef, update, { merge: true });
      transaction.set(orderRef, update, { merge: true });
    });
    return;
  }

  const stockSnap = await getDocs(collection(db, "stock"));
  const stockByName = new Map<string, typeof stockSnap.docs[number]>();
  for (const stockDoc of stockSnap.docs) {
    const stockData = stockDoc.data();
    if (typeof stockData.name === "string" && !stockByName.has(stockData.name)) {
      stockByName.set(stockData.name, stockDoc);
    }
  }

  await runTransaction(db, async (transaction) => {
    const customerSnap = await transaction.get(customerRef);
    if (!customerSnap.exists()) throw new Error("Queue entry not found.");

    const customerData = customerSnap.data();
    const alreadyServed =
      customerData.status === "served" || customerData.wasServed === true;
    if (alreadyServed) return;

    const patientType =
      customerData.patientType === "pwd" ? "pwd_patients" : "regular_patients";
    const patientRef = doc(db, patientType, id);
    const orderRef = doc(db, "orders", id);
    const dispensedAt = serverTimestamp();

    const servedUpdate = {
      status,
      wasServed: true,
      dispensedAt,
      updatedAt: serverTimestamp(),
    };

    const medicines = Array.isArray(customerData.medicines)
      ? (customerData.medicines as unknown[])
      : [];
    const quantities = Array.isArray(customerData.quantities)
      ? (customerData.quantities as unknown[])
      : [];
    const deductions = new Map<string, number>();

    medicines.forEach((medicine, index) => {
      if (typeof medicine !== "string") return;
      const quantity = Number(quantities[index] ?? 1);
      deductions.set(
        medicine,
        (deductions.get(medicine) ?? 0) +
          (Number.isFinite(quantity) && quantity > 0 ? quantity : 1)
      );
    });

    const stockDeductions = [...deductions].flatMap(
      ([medicineName, quantity]) => {
        const stockDoc = stockByName.get(medicineName);
        return stockDoc
          ? [{ ref: doc(db, "stock", stockDoc.id), quantity }]
          : [];
      }
    );
    const stockSnapshots = await Promise.all(
      stockDeductions.map(async ({ ref, quantity }) => ({
        ref,
        quantity,
        snapshot: await transaction.get(ref),
      }))
    );

    stockSnapshots.forEach(({ ref, quantity, snapshot: stockCurrent }) => {
      if (!stockCurrent.exists()) return;

      const stockData = stockCurrent.data();
      const currentStock =
        typeof stockData.stock === "number" && Number.isFinite(stockData.stock)
          ? Math.max(0, stockData.stock)
          : 0;
      const newStock = Math.max(0, currentStock - quantity);
      transaction.update(ref, {
        stock: newStock,
        manualUnavailable:
          stockData.manualUnavailable === true ||
          (stockData.manualUnavailable === undefined &&
            stockData.available === false &&
            currentStock > 0),
        available:
          newStock > 0 &&
          stockData.manualUnavailable !== true &&
          !(
            stockData.manualUnavailable === undefined &&
            stockData.available === false &&
            currentStock > 0
          ),
        updatedAt: serverTimestamp(),
      });
    });

    transaction.update(customerRef, servedUpdate);
    transaction.set(patientRef, servedUpdate, { merge: true });
    transaction.set(orderRef, servedUpdate, { merge: true });
  });
}

export async function archiveQueueEntry(
  id: string,
  reason = "no_show"
): Promise<void> {
  return updateQueueEntryStatus(id, "archived", { archivedReason: reason });
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
