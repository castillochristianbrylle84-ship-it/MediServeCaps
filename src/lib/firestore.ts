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
  isNewStock?: boolean;
  waitingForOldStock?: boolean;
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
  nowMs = Date.now(),
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
  nowMs = Date.now(),
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

function normalizeMedicineName(name: string): string {
  return name.trim().toLowerCase();
}

function getStockCreatedTimeMs(data: {
  createdAt?: Timestamp;
  receivedDate?: string;
}): number {
  if (data.createdAt instanceof Timestamp) {
    return data.createdAt.toMillis();
  }
  if (typeof data.receivedDate === "string" && data.receivedDate) {
    const parsed = Date.parse(data.receivedDate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function sortStockItemsOldestFirst<
  T extends {
    id: string;
    name?: string;
    isNewStock?: boolean;
    createdAt?: Timestamp;
    receivedDate?: string;
  },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aNew = a.isNewStock === true ? 1 : 0;
    const bNew = b.isNewStock === true ? 1 : 0;
    if (aNew !== bNew) return aNew - bNew;
    const timeDiff = getStockCreatedTimeMs(a) - getStockCreatedTimeMs(b);
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

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
    isNewStock: data.isNewStock === true,
    waitingForOldStock: data.waitingForOldStock === true,
    available: stock > 0 && data.available === true && !manualUnavailable,
  } as StockItem;
}

export function isStockItemAvailable(item: StockItem): boolean {
  return item.stock > 0 && item.available && item.manualUnavailable !== true;
}

export async function getStockItems(): Promise<StockItem[]> {
  const snap = await getDocs(collection(db, "stock"));
  return sortStockItemsOldestFirst(
    snap.docs.map((d) => toStockItem(d.id, d.data())),
  );
}

export function subscribeStockItems(
  cb: (items: StockItem[]) => void,
): Unsubscribe {
  return onSnapshot(collection(db, "stock"), (snap) => {
    cb(
      sortStockItemsOldestFirst(
        snap.docs.map((d) => toStockItem(d.id, d.data())),
      ),
    );
  });
}

export async function addStockItem(
  item: Omit<StockItem, "id">,
): Promise<string> {
  const normalizedTargetName = normalizeMedicineName(item.name);
  const existingSnap = await getDocs(collection(db, "stock"));
  const sameMedicineDocs = existingSnap.docs.filter((d) => {
    const data = d.data();
    return (
      typeof data.name === "string" &&
      normalizeMedicineName(data.name) === normalizedTargetName
    );
  });

  const isReplacementOrAdditionalStock = sameMedicineDocs.length > 0;
  let hasActiveOldStock = false;

  for (const existingDoc of sameMedicineDocs) {
    const existingData = existingDoc.data();
    const existingQty =
      typeof existingData.stock === "number" &&
      Number.isFinite(existingData.stock)
        ? Math.max(0, existingData.stock)
        : 0;
    if (existingQty > 0) {
      hasActiveOldStock = true;
      if (existingData.isNewStock === true) {
        await updateDoc(doc(db, "stock", existingDoc.id), {
          isNewStock: false,
          waitingForOldStock: false,
          updatedAt: serverTimestamp(),
        });
      }
    } else if (existingData.isNewStock === true) {
      await updateDoc(doc(db, "stock", existingDoc.id), {
        isNewStock: false,
        waitingForOldStock: false,
        updatedAt: serverTimestamp(),
      });
    }
  }

  const cleanStock = Number.isFinite(item.stock) ? Math.max(0, item.stock) : 0;
  // When adding a new stock of the same medicine while old stock still has quantity > 0,
  // automatically set the new stock to Unavailable until old stock hits 0.
  const autoUnavailable = isReplacementOrAdditionalStock && hasActiveOldStock;
  const manualUnavailable = autoUnavailable
    ? true
    : item.manualUnavailable === true;
  const available =
    cleanStock > 0 &&
    !manualUnavailable &&
    (autoUnavailable ? false : item.available);

  const ref = await addDoc(collection(db, "stock"), {
    ...item,
    stock: cleanStock,
    manualUnavailable,
    isNewStock: isReplacementOrAdditionalStock,
    waitingForOldStock: autoUnavailable,
    available,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateStockItem(
  id: string,
  data: Partial<Omit<StockItem, "id">>,
): Promise<void> {
  const stockRef = doc(db, "stock", id);
  let resultingName = "";
  let resultingStock = -1;

  await runTransaction(db, async (transaction) => {
    const stockSnap = await transaction.get(stockRef);
    if (!stockSnap.exists()) throw new Error("Medicine not found.");

    const currentData = stockSnap.data();
    const currentStock =
      typeof currentData.stock === "number" &&
      Number.isFinite(currentData.stock)
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

    resultingName =
      typeof data.name === "string"
        ? data.name
        : typeof currentData.name === "string"
          ? currentData.name
          : "";
    resultingStock = stock;

    transaction.update(stockRef, {
      ...data,
      stock,
      manualUnavailable,
      ...(stock === 0 ? { waitingForOldStock: false } : {}),
      available: stock > 0 && !manualUnavailable,
      updatedAt: serverTimestamp(),
    });
  });

  // When old stock hits 0 quantity, automatically make the new stock of the same medicine available
  if (resultingStock === 0 && resultingName) {
    const normalizedName = normalizeMedicineName(resultingName);
    const allSnap = await getDocs(collection(db, "stock"));
    const sameMedItems = sortStockItemsOldestFirst(
      allSnap.docs
        .map((d) => toStockItem(d.id, d.data()))
        .filter((item) => normalizeMedicineName(item.name) === normalizedName),
    );
    const hasAnotherAvailable = sameMedItems.some(
      (item) => item.id !== id && isStockItemAvailable(item),
    );
    if (!hasAnotherAvailable) {
      const nextBatchWithStock = sameMedItems.find(
        (item) => item.id !== id && item.stock > 0,
      );
      if (nextBatchWithStock) {
        await updateDoc(doc(db, "stock", nextBatchWithStock.id), {
          available: true,
          manualUnavailable: false,
          waitingForOldStock: false,
          isNewStock: true,
          updatedAt: serverTimestamp(),
        });
      }
    }
  }
}

export async function setStockItemAvailability(
  id: string,
  available: boolean,
  options?: { waitingForOldStock?: boolean },
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
      waitingForOldStock: available
        ? false
        : (options?.waitingForOldStock ?? false),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function deleteStockItem(id: string): Promise<void> {
  await deleteDoc(doc(db, "stock", id));
}

export async function deductStock(
  medicineName: string,
  qty: number,
): Promise<void> {
  const normalizedTarget = normalizeMedicineName(medicineName);
  const snap = await getDocs(collection(db, "stock"));
  const matchingDocs = sortStockItemsOldestFirst(
    snap.docs
      .map((d) => toStockItem(d.id, d.data()))
      .filter((d) => normalizeMedicineName(d.name) === normalizedTarget),
  );

  let remainingToDeduct = qty;
  let oldStockHitZero = false;

  for (let i = 0; i < matchingDocs.length; i++) {
    if (remainingToDeduct <= 0) break;
    const d = matchingDocs[i];
    if (d.stock <= 0) continue;

    const deducted = Math.min(d.stock, remainingToDeduct);
    const newStock = Math.max(0, d.stock - deducted);
    remainingToDeduct -= deducted;

    if (newStock === 0) {
      oldStockHitZero = true;
    }

    await updateDoc(doc(db, "stock", d.id), {
      stock: newStock,
      ...(newStock === 0
        ? { available: false, waitingForOldStock: false }
        : {}),
      updatedAt: serverTimestamp(),
    });
  }

  if (oldStockHitZero) {
    const refreshedSnap = await getDocs(collection(db, "stock"));
    const refreshedItems = sortStockItemsOldestFirst(
      refreshedSnap.docs
        .map((d) => toStockItem(d.id, d.data()))
        .filter((d) => normalizeMedicineName(d.name) === normalizedTarget),
    );
    const anyAvailable = refreshedItems.some((item) =>
      isStockItemAvailable(item),
    );
    if (!anyAvailable) {
      const nextWithStock = refreshedItems.find((item) => item.stock > 0);
      if (nextWithStock) {
        await updateDoc(doc(db, "stock", nextWithStock.id), {
          available: true,
          manualUnavailable: false,
          waitingForOldStock: false,
          isNewStock: true,
          updatedAt: serverTimestamp(),
        });
      }
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
        typeof data.archivedReason === "string"
          ? data.archivedReason
          : undefined,
      wasServed: data.wasServed === true,
      updatedAt:
        data.updatedAt instanceof Timestamp ? data.updatedAt : undefined,
      createdAt:
        data.createdAt instanceof Timestamp ? data.createdAt : undefined,
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
  endDate: string,
): Promise<QueueEntry[]> {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const [dateTagged, timestamped] = await Promise.all([
    getDocs(
      query(
        collection(db, "customers"),
        where("queueDate", ">=", startDate),
        where("queueDate", "<=", endDate),
      ),
    ),
    getDocs(
      query(
        collection(db, "customers"),
        where("timestamp", ">=", start.toISOString()),
        where("timestamp", "<", end.toISOString()),
      ),
    ),
  ]);
  const entries = new Map(
    snapToEntries(dateTagged).map((entry) => [entry.id, entry]),
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
      query(collection(db, "customers"), where("queueDate", "==", queueDate)),
    ),
    getDocs(
      query(
        collection(db, "customers"),
        where("createdAt", ">=", Timestamp.fromDate(start)),
        where("createdAt", "<", Timestamp.fromDate(end)),
      ),
    ),
  ]);
  const entries = new Map(
    snapToEntries(dateTagged).map((entry) => [entry.id, entry]),
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
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}

export function subscribeQueueEntries(
  cb: (entries: QueueEntry[]) => void,
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
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      ),
    );
  };

  const subscribeToDate = () => {
    dateUnsubscribe();
    legacyUnsubscribe();
    dateEntries = new Map();
    legacyEntries = new Map();

    const [start, end] = getQueueDateRange(queueDate);
    dateUnsubscribe = onSnapshot(
      query(collection(db, "customers"), where("queueDate", "==", queueDate)),
      (snap) => {
        dateEntries = new Map(
          snapToEntries(snap).map((entry) => [entry.id, entry]),
        );
        publish();
      },
      (error) => console.error("Could not subscribe to today's queue:", error),
    );
    legacyUnsubscribe = onSnapshot(
      query(
        collection(db, "customers"),
        where("createdAt", ">=", Timestamp.fromDate(start)),
        where("createdAt", "<", Timestamp.fromDate(end)),
      ),
      (snap) => {
        legacyEntries = new Map(
          snapToEntries(snap)
            .filter(
              (entry) => !entry.queueDate || entry.queueDate === queueDate,
            )
            .map((entry) => [entry.id, entry]),
        );
        publish();
      },
      (error) =>
        console.error("Could not subscribe to legacy queue entries:", error),
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
  patientType: QueueEntry["patientType"],
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
  entry: Omit<QueueEntry, "id">,
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
  metadata?: { archivedReason?: string },
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
              entry.status !== "archived",
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
            entrySnap.get("wasServed") !== true,
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
              { merge: true },
            );
            transaction.set(doc(db, "orders", alreadyReady.id), archiveUpdate, {
              merge: true,
            });
          } else {
            const queueNumber = alreadyReady.get("queueNumber") ?? "unknown";
            throw new Error(
              `Queue #${queueNumber} is currently in "Get Ready". Mark them as Served before setting another patient to Get Ready.`,
            );
          }
        }
      }

      const customerData = customerSnap.data();
      const patientType =
        customerData.patientType === "pwd"
          ? "pwd_patients"
          : "regular_patients";
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
  const stockDocsByName = new Map<string, typeof stockSnap.docs>();
  for (const stockDoc of stockSnap.docs) {
    const stockData = stockDoc.data();
    if (typeof stockData.name === "string") {
      const key = normalizeMedicineName(stockData.name);
      const list = stockDocsByName.get(key) ?? [];
      list.push(stockDoc);
      stockDocsByName.set(key, list);
    }
  }
  for (const [key, docs] of stockDocsByName.entries()) {
    const sorted = sortStockItemsOldestFirst(
      docs.map((d) => ({
        id: d.id,
        doc: d,
        isNewStock: d.data().isNewStock === true,
        createdAt:
          d.data().createdAt instanceof Timestamp
            ? d.data().createdAt
            : undefined,
        receivedDate:
          typeof d.data().receivedDate === "string"
            ? d.data().receivedDate
            : undefined,
      })),
    ).map((item) => item.doc);
    stockDocsByName.set(key, sorted);
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
      const key = normalizeMedicineName(medicine);
      const quantity = Number(quantities[index] ?? 1);
      deductions.set(
        key,
        (deductions.get(key) ?? 0) +
          (Number.isFinite(quantity) && quantity > 0 ? quantity : 1),
      );
    });

    const stockDeductionGroups = await Promise.all(
      [...deductions].map(async ([normalizedName, quantity]) => {
        const docs = stockDocsByName.get(normalizedName) ?? [];
        const snapshots = await Promise.all(
          docs.map(async (stockDoc) => {
            const ref = doc(db, "stock", stockDoc.id);
            return {
              ref,
              snapshot: await transaction.get(ref),
            };
          }),
        );
        return { quantity, snapshots };
      }),
    );

    stockDeductionGroups.forEach(({ quantity, snapshots }) => {
      const existingSnapshots = snapshots.filter((s) => s.snapshot.exists());
      let remaining = quantity;
      let oldBatchDepleted = false;
      const finalStocks: number[] = [];

      existingSnapshots.forEach(({ ref, snapshot: stockCurrent }) => {
        const stockData = stockCurrent.data()!;
        const currentStock =
          typeof stockData.stock === "number" &&
          Number.isFinite(stockData.stock)
            ? Math.max(0, stockData.stock)
            : 0;

        if (currentStock <= 0 || remaining <= 0) {
          finalStocks.push(currentStock);
          return;
        }

        const deductAmount = Math.min(currentStock, remaining);
        const newStock = Math.max(0, currentStock - deductAmount);
        remaining -= deductAmount;
        finalStocks.push(newStock);

        if (currentStock > 0 && newStock === 0) {
          oldBatchDepleted = true;
        }

        transaction.update(ref, {
          stock: newStock,
          manualUnavailable:
            stockData.manualUnavailable === true ||
            (stockData.manualUnavailable === undefined &&
              stockData.available === false &&
              currentStock > 0),
          ...(newStock === 0 ? { waitingForOldStock: false } : {}),
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

      // If an older batch hit 0 during this serve transaction, automatically make the next batch with stock > 0 available
      if (oldBatchDepleted && existingSnapshots.length > 1) {
        const nextIdx = existingSnapshots.findIndex(
          (_, idx) => finalStocks[idx] > 0,
        );
        if (nextIdx !== -1) {
          const nextBatch = existingSnapshots[nextIdx];
          transaction.update(nextBatch.ref, {
            stock: finalStocks[nextIdx],
            available: true,
            manualUnavailable: false,
            waitingForOldStock: false,
            isNewStock: true,
            updatedAt: serverTimestamp(),
          });
        }
      }
    });

    transaction.update(customerRef, servedUpdate);
    transaction.set(patientRef, servedUpdate, { merge: true });
    transaction.set(orderRef, servedUpdate, { merge: true });
  });
}

export async function archiveQueueEntry(
  id: string,
  reason = "no_show",
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
