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
  orderBy,
  serverTimestamp,
  Timestamp,
  runTransaction,
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
  queueNumber: string;
  patientName: string;
  address: string;
  phone?: string;
  patientType: "regular" | "pwd";
  seniorIdNumber?: string;
  medicines: string[];
  quantities: number[];
  status: "waiting" | "processing" | "getready" | "served";
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

function snapToEntries(snap: QuerySnapshot<DocumentData>): QueueEntry[] {
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
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
  const snap = await getDocs(
    query(collection(db, "customers"), orderBy("createdAt", "desc"))
  );
  return snapToEntries(snap);
}

export function subscribeQueueEntries(
  cb: (entries: QueueEntry[]) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, "customers"), orderBy("createdAt", "desc")),
    (snap) => cb(snapToEntries(snap))
  );
}

export async function getNextQueueNumber(
  patientType: QueueEntry["patientType"]
): Promise<string> {
  const counterRef = doc(db, "queueCounters", patientType);

  const nextNumber = await runTransaction(db, async (transaction) => {
    const counterSnap = await transaction.get(counterRef);
    const currentNumber = Number(counterSnap.data()?.lastNumber ?? 0);
    const next = currentNumber + 1;

    if (counterSnap.exists()) {
      transaction.update(counterRef, {
        lastNumber: next,
        updatedAt: serverTimestamp(),
      });
    } else {
      transaction.set(counterRef, {
        patientType,
        lastNumber: next,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    return next;
  });

  return String(nextNumber);
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
