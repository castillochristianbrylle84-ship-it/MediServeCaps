import { createHash, timingSafeEqual } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

const TIME_ZONE = "Asia/Manila";
const BATCH_TICKET_LIMIT = 150;

function getDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function getPreviousQueueDateRange(today: string): {
  queueDate: string;
  start: Date;
  end: Date;
} {
  const end = new Date(`${today}T00:00:00+08:00`);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  return { queueDate: getDateString(start), start, end };
}

function isAuthorized(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedHash = createHash("sha256").update(secret).digest();
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();

  return timingSafeEqual(expectedHash, suppliedHash);
}

async function findPreviousDayTickets(
  queueDate: string,
  start: Date,
  end: Date
): Promise<Map<string, QueryDocumentSnapshot<DocumentData>>> {
  const db = getAdminDb();
  const [dateTagged, legacy] = await Promise.all([
    db.collection("customers").where("queueDate", "==", queueDate).get(),
    db
      .collection("customers")
      .where("createdAt", ">=", Timestamp.fromDate(start))
      .where("createdAt", "<", Timestamp.fromDate(end))
      .get(),
  ]);

  const tickets = new Map<
    string,
    QueryDocumentSnapshot<DocumentData>
  >();
  for (const ticket of [...dateTagged.docs, ...legacy.docs]) {
    if (!ticket.get("queueDate") || ticket.get("queueDate") === queueDate) {
      tickets.set(ticket.id, ticket);
    }
  }

  return tickets;
}

async function archiveTickets(
  tickets: QueryDocumentSnapshot<DocumentData>[]
): Promise<number> {
  const db = getAdminDb();
  const activeTickets = tickets.filter(
    (ticket) => ticket.get("status") !== "archived"
  );

  for (
    let offset = 0;
    offset < activeTickets.length;
    offset += BATCH_TICKET_LIMIT
  ) {
    const batch = db.batch();
    const chunk = activeTickets.slice(
      offset,
      offset + BATCH_TICKET_LIMIT
    );

    for (const ticket of chunk) {
      const update = {
        status: "archived",
        updatedAt: FieldValue.serverTimestamp(),
      };
      const patientCollection =
        ticket.get("patientType") === "pwd"
          ? "pwd_patients"
          : "regular_patients";

      batch.update(ticket.ref, update);
      batch.set(db.collection("orders").doc(ticket.id), update, {
        merge: true,
      });
      batch.set(
        db.collection(patientCollection).doc(ticket.id),
        update,
        { merge: true }
      );
    }

    await batch.commit();
  }

  return activeTickets.length;
}

async function resetDailyCounters(today: string): Promise<void> {
  const db = getAdminDb();
  const metadataRef = db.collection("queue_metadata").doc("today");
  const regularCounterRef = db.collection("queueCounters").doc("regular");
  const pwdCounterRef = db.collection("queueCounters").doc("pwd");

  await db.runTransaction(async (transaction) => {
    const [metadataSnapshot, regularSnapshot, pwdSnapshot] =
      await Promise.all([
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
    ] as const) {
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

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured.");
    return Response.json(
      { error: "Queue reset is not configured." },
      { status: 500 }
    );
  }

  if (!isAuthorized(request, cronSecret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

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

    return Response.json({
      success: true,
      queueDate: previousDay.queueDate,
      archivedCount,
      currentDate: today,
    });
  } catch (error) {
    console.error("Daily queue rollover failed:", error);
    return Response.json(
      { error: "Daily queue rollover failed." },
      { status: 500 }
    );
  }
}
