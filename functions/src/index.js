import { initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const db = getFirestore();
const TIME_ZONE = "Asia/Manila";
const BATCH_TICKET_LIMIT = 150;
const queueSmsWebhookSecret = defineSecret("QUEUE_ADVANCE_WEBHOOK_SECRET");

function getDateString(date) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function getQueueDateRange(queueDate) {
  const start = new Date(`${queueDate}T00:00:00+08:00`);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}

function getPreviousQueueDateRange(today) {
  const end = new Date(`${today}T00:00:00+08:00`);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    queueDate: getDateString(start),
    start,
    end,
  };
}

function normalizePhilippinePhoneNumber(input) {
  const compact = input.trim().replace(/[\s()-]/g, "");
  if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^\+639\d{9}$/.test(compact)) return compact;
  if (/^639\d{9}$/.test(compact)) return `+${compact}`;
  return null;
}

function getTimestampValue(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  return 0;
}

function compareQueueOrder(left, right) {
  if (left.patientType === "pwd" && right.patientType !== "pwd") return -1;
  if (left.patientType !== "pwd" && right.patientType === "pwd") return 1;
  return getTimestampValue(left.timestamp) - getTimestampValue(right.timestamp);
}

async function findPreviousDayTickets(queueDate, start, end) {
  const [dateTagged, legacy] = await Promise.all([
    db.collection("customers").where("queueDate", "==", queueDate).get(),
    db.collection("customers")
      .where("createdAt", ">=", Timestamp.fromDate(start))
      .where("createdAt", "<", Timestamp.fromDate(end))
      .get(),
  ]);
  const tickets = new Map();
  for (const ticket of [...dateTagged.docs, ...legacy.docs]) {
    if (!ticket.get("queueDate") || ticket.get("queueDate") === queueDate) {
      tickets.set(ticket.id, ticket);
    }
  }
  return tickets;
}

async function archiveTickets(tickets) {
  const activeTickets = tickets.filter(
    (ticket) => ticket.get("status") !== "archived"
  );
  for (
    let offset = 0;
    offset < activeTickets.length;
    offset += BATCH_TICKET_LIMIT
  ) {
    const batch = db.batch();
    const chunk = activeTickets.slice(offset, offset + BATCH_TICKET_LIMIT);
    for (const ticket of chunk) {
      const update = {
        status: "archived",
        updatedAt: FieldValue.serverTimestamp(),
      };
      const patientCollection =
        ticket.get("patientType") === "pwd" ? "pwd_patients" : "regular_patients";
      batch.update(ticket.ref, update);
      batch.set(db.collection("orders").doc(ticket.id), update, {
        merge: true,
      });
      batch.set(db.collection(patientCollection).doc(ticket.id), update, {
        merge: true,
      });
    }
    await batch.commit();
  }
  return activeTickets.length;
}

async function resetDailyCounters(today) {
  const metadataRef = db.collection("queue_metadata").doc("today");
  const regularCounterRef = db.collection("queueCounters").doc("regular");
  const pwdCounterRef = db.collection("queueCounters").doc("pwd");

  await db.runTransaction(async (transaction) => {
    const [metadataSnapshot, regularSnapshot, pwdSnapshot] = await Promise.all([
      transaction.get(metadataRef),
      transaction.get(regularCounterRef),
      transaction.get(pwdCounterRef),
    ]);
    const metadata = metadataSnapshot.data();
    const sameDate = metadata?.date === today;
    transaction.set(
      metadataRef,
      {
        date: today,
        lastNumbers: sameDate
          ? {
              regular: Number(metadata.lastNumbers?.regular ?? 0),
              pwd: Number(metadata.lastNumbers?.pwd ?? 0),
            }
          : { regular: 0, pwd: 0 },
        currentServeNumber: sameDate
          ? Number(metadata.currentServeNumber ?? 0)
          : 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    for (const [ref, snapshot, patientType] of [
      [regularCounterRef, regularSnapshot, "regular"],
      [pwdCounterRef, pwdSnapshot, "pwd"],
    ]) {
      transaction.set(
        ref,
        {
          ...(snapshot.data() ?? {}),
          patientType,
          lastNumber: 0,
          date: today,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  });
}

export const resetDailyQueue = onSchedule(
  {
    schedule: "0 0 * * *",
    timeZone: TIME_ZONE,
  },
  async () => {
    const today = getDateString(new Date());
    const previousDay = getPreviousQueueDateRange(today);
    try {
      const tickets = await findPreviousDayTickets(
        previousDay.queueDate,
        previousDay.start,
        previousDay.end
      );
      const archivedCount = await archiveTickets([...tickets.values()]);
      await resetDailyCounters(today);
      logger.info("Daily queue rollover completed", {
        queueDate: previousDay.queueDate,
        archivedCount,
        currentDate: today,
      });
    } catch (error) {
      logger.error("Daily queue rollover failed", {
        queueDate: previousDay.queueDate,
        error,
      });
      throw error;
    }
  }
);

async function claimOngoingNotification(queueDate, ongoingQueueNumber, recipientId) {
  const notificationId = `${queueDate}_${ongoingQueueNumber}_${recipientId}`;
  const notificationRef = db
    .collection("queue_ongoing_notifications")
    .doc(notificationId);

  return db.runTransaction(async (transaction) => {
    const notificationSnap = await transaction.get(notificationRef);
    if (notificationSnap.exists) return false;
    transaction.create(notificationRef, {
      queueDate,
      ongoingQueueNumber,
      recipientEntryId: recipientId,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export const notifyQueueAdvance = onDocumentUpdated(
  {
    document: "customers/{ticketId}",
    secrets: [queueSmsWebhookSecret],
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const becameServed =
      before?.status !== "served" && after?.status === "served";
    const becameActive =
      ["processing", "getready"].includes(after?.status) &&
      before?.status !== after?.status;
    if (
      !before ||
      !after ||
      (!becameServed && !becameActive)
    ) {
      return;
    }

    const timestamp = getTimestampValue(after.timestamp);
    const queueDate =
      typeof after.queueDate === "string"
        ? after.queueDate
        : timestamp > 0
          ? getDateString(new Date(timestamp))
          : null;
    if (!queueDate) {
      logger.error("Served ticket has no valid queue date", {
        ticketId: event.params.ticketId,
      });
      return;
    }
    if (queueDate !== getDateString(new Date())) return;

    const { start, end } = getQueueDateRange(queueDate);
    const [dateTagged, legacy] = await Promise.all([
      db.collection("customers").where("queueDate", "==", queueDate).get(),
      db.collection("customers")
        .where("createdAt", ">=", Timestamp.fromDate(start))
        .where("createdAt", "<", Timestamp.fromDate(end))
        .get(),
    ]);
    const queueTickets = new Map();
    for (const ticket of [...dateTagged.docs, ...legacy.docs]) {
      if (!ticket.get("queueDate") || ticket.get("queueDate") === queueDate) {
        queueTickets.set(ticket.id, ticket);
      }
    }

    const activeEntries = [...queueTickets.values()]
      .filter((ticket) => {
        const status = ticket.get("status");
        return status !== "served" && status !== "archived";
      })
      .map((ticket) => ({
        id: ticket.id,
        patientType: ticket.get("patientType"),
        queueNumber: String(ticket.get("queueNumber") ?? ""),
        timestamp: ticket.get("timestamp"),
        status: ticket.get("status"),
        phone: ticket.get("phone"),
      }))
      .sort(compareQueueOrder);

    const ongoingEntry = activeEntries[0];
    const ongoingQueueNumber = Number(ongoingEntry?.queueNumber);
    if (!ongoingEntry || !Number.isInteger(ongoingQueueNumber)) {
      logger.info("No valid ongoing queue number remains after service completion", {
        ticketId: event.params.ticketId,
        queueDate,
      });
      return;
    }

    const recipients = activeEntries.filter((entry) => {
      const queueNumber = Number(entry.queueNumber);
      return (
        entry.id !== ongoingEntry.id &&
        ["waiting", "processing", "getready"].includes(entry.status) &&
        Number.isInteger(queueNumber) &&
        queueNumber > ongoingQueueNumber &&
        queueNumber <= ongoingQueueNumber + 5 &&
        typeof entry.phone === "string" &&
        normalizePhilippinePhoneNumber(entry.phone) !== null
      );
    });

    const claimedMessages = [];
    for (const recipient of recipients) {
      const claimed = await claimOngoingNotification(
        queueDate,
        ongoingQueueNumber,
        recipient.id
      );
      if (!claimed) continue;

      claimedMessages.push({
        notificationId: `${queueDate}_${ongoingQueueNumber}_${recipient.id}`,
        phoneNumber: recipient.phone,
        message: `Queue number ${ongoingQueueNumber} ongoing`,
      });
    }
    if (claimedMessages.length === 0) return;

    const apiBaseUrl = process.env.MEDISERVE_API_BASE_URL?.replace(/\/$/, "");
    const notificationRefs = claimedMessages.map((message) => ({
      message,
      ref: db
        .collection("queue_ongoing_notifications")
        .doc(message.notificationId),
    }));

    try {
      if (!apiBaseUrl) {
        throw new Error("MEDISERVE_API_BASE_URL is not configured for Functions.");
      }
      const response = await fetch(
        `${apiBaseUrl}/api/internal/queue-advance-sms`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${queueSmsWebhookSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: claimedMessages }),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!response.ok) {
        throw new Error(`Queue SMS endpoint returned HTTP ${response.status}.`);
      }

      const result = await response.json();
      const deliveries = new Map(
        Array.isArray(result?.results)
          ? result.results.map((delivery) => [
              delivery.notificationId,
              delivery.status,
            ])
          : []
      );
      await Promise.all(
        notificationRefs.map(({ message, ref }) => {
          const status = deliveries.get(message.notificationId);
          return ref.update({
            status: status === "sent" ? "sent" : "failed",
            ...(status === "sent"
              ? { sentAt: FieldValue.serverTimestamp() }
              : {
                  failedAt: FieldValue.serverTimestamp(),
                  error: `SMS delivery status: ${status ?? "missing"}`,
                }),
          });
        })
      );
    } catch (error) {
      logger.error("Could not dispatch queue-ongoing SMS notifications", {
        queueDate,
        ongoingQueueNumber,
        error,
      });
      await Promise.all(
        notificationRefs.map(({ ref }) =>
          ref.update({
            status: "failed",
            failedAt: FieldValue.serverTimestamp(),
            error: error instanceof Error ? error.message : String(error),
          })
        )
      );
    }
  }
);
