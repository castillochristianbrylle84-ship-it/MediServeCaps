import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type PatientType = "regular" | "pwd";

function getQueueDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("patientType" in body) ||
    (body.patientType !== "regular" && body.patientType !== "pwd")
  ) {
    return Response.json({ error: "Invalid patient type." }, { status: 400 });
  }

  const patientType: PatientType = body.patientType;
  const queueDate = getQueueDate();

  try {
    const db = getAdminDb();
    const metadataRef = db.collection("queue_metadata").doc("today");
    const legacyCounterRef = db
      .collection("queueCounters")
      .doc(patientType);
    const nextNumber = await db.runTransaction(async (transaction) => {
      const metadataSnapshot = await transaction.get(metadataRef);
      const metadata = metadataSnapshot.data();
      const sameDate = metadata?.date === queueDate;
      let currentNumber = Number(
        sameDate ? metadata.lastNumbers?.[patientType] ?? 0 : 0
      );

      if (!metadataSnapshot.exists) {
        const legacyCounterSnapshot = await transaction.get(legacyCounterRef);
        currentNumber = Number(
          legacyCounterSnapshot.data()?.lastNumber ?? 0
        );
      }

      const next = currentNumber + 1;
      transaction.set(
        metadataRef,
        {
          date: queueDate,
          lastNumbers: {
            regular: sameDate
              ? Number(metadata.lastNumbers?.regular ?? 0)
              : 0,
            pwd: sameDate ? Number(metadata.lastNumbers?.pwd ?? 0) : 0,
            [patientType]: next,
          },
          currentServeNumber: sameDate
            ? Number(metadata.currentServeNumber ?? 0)
            : 0,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return next;
    });

    return Response.json({
      queueDate,
      queueNumber: String(nextNumber),
    });
  } catch (error) {
    console.error("Could not allocate a queue number:", error);
    return Response.json(
      { error: "Could not allocate a queue number." },
      { status: 500 }
    );
  }
}
