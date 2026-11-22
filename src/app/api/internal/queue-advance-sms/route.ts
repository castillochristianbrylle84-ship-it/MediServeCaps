import { timingSafeEqual } from "node:crypto";
import {
  normalizePhilippinePhoneNumber,
  sendSMSNotification,
} from "@/lib/sms";

export const runtime = "nodejs";

interface QueueAdvanceMessage {
  notificationId: string;
  phoneNumber: string;
  message: string;
}

function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.QUEUE_ADVANCE_WEBHOOK_SECRET;
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!expectedSecret || !match) return false;

  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(match[1]);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("messages" in body) ||
    !Array.isArray(body.messages) ||
    body.messages.length > 100
  ) {
    return Response.json({ error: "Invalid SMS message list." }, { status: 400 });
  }

  const messages = body.messages.filter(
    (message): message is QueueAdvanceMessage =>
      !!message &&
      typeof message === "object" &&
      "notificationId" in message &&
      typeof message.notificationId === "string" &&
      "phoneNumber" in message &&
      typeof message.phoneNumber === "string" &&
      "message" in message &&
      typeof message.message === "string"
  );
  if (messages.length !== body.messages.length) {
    return Response.json({ error: "Invalid SMS message entry." }, { status: 400 });
  }

  const results = await Promise.all(messages.map(async (item) => {
    const phoneNumber = normalizePhilippinePhoneNumber(item.phoneNumber);
    if (!phoneNumber) {
      return { notificationId: item.notificationId, status: "skipped" };
    }

    try {
      await sendSMSNotification(phoneNumber, item.message);
      return { notificationId: item.notificationId, status: "sent" };
    } catch (error) {
      console.error("Could not send queue-ongoing SMS:", {
        notificationId: item.notificationId,
        error,
      });
      return { notificationId: item.notificationId, status: "failed" };
    }
  }));

  return Response.json({ results });
}
