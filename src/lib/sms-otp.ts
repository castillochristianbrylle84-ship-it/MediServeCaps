import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Transaction } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { getSmsAdminDb } from "@/lib/sms-admin";
import { generateOtp } from "@/lib/sms";

const OTP_LIFETIME_MS = 5 * 60 * 1000;
const RESEND_DELAY_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

function hashOtp(phoneNumber: string, code: string): string {
  const secret = process.env.OTP_HASH_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("OTP_HASH_SECRET must contain at least 32 characters.");
  }

  return createHmac("sha256", secret)
    .update(`${phoneNumber}:${code}`)
    .digest("hex");
}

export async function issueOtp(
  phoneNumber: string
): Promise<{
  code?: string;
  retryAfterSeconds?: number;
}> {
  const smsAdminDb = getSmsAdminDb();

  const code = generateOtp();
  const codeHash = hashOtp(phoneNumber, code);
  const now = Date.now();

  const challengeRef = smsAdminDb
    .collection("smsOtpChallenges")
    .doc(phoneNumber);

  const rateLimitRef = smsAdminDb
    .collection("smsOtpRateLimits")
    .doc(phoneNumber);

  const retryAfterSeconds = await smsAdminDb.runTransaction(
    async (transaction: Transaction) => {
      const rateLimit = await transaction.get(rateLimitRef);

      const lastSentAt = rateLimit.get("lastSentAt") as
        | Timestamp
        | undefined;

      if (lastSentAt) {
        const remaining =
          RESEND_DELAY_MS - (now - lastSentAt.toMillis());

        if (remaining > 0) {
          return Math.ceil(remaining / 1000);
        }
      }

      const windowStart = rateLimit.get("windowStart") as
        | Timestamp
        | undefined;

      const inCurrentWindow =
        windowStart &&
        now - windowStart.toMillis() < RATE_WINDOW_MS;

      const requestCount = inCurrentWindow
        ? Number(rateLimit.get("requestCount") ?? 0)
        : 0;

      if (
        requestCount >= MAX_REQUESTS_PER_HOUR &&
        windowStart
      ) {
        return Math.ceil(
          (windowStart.toMillis() + RATE_WINDOW_MS - now) / 1000
        );
      }

      transaction.set(rateLimitRef, {
        lastSentAt: Timestamp.fromMillis(now),
        windowStart: inCurrentWindow
          ? windowStart
          : Timestamp.fromMillis(now),
        requestCount: requestCount + 1,
      });

      transaction.set(challengeRef, {
        codeHash,
        attempts: 0,
        expiresAt: Timestamp.fromMillis(
          now + OTP_LIFETIME_MS
        ),
        createdAt: Timestamp.fromMillis(now),
      });

      return 0;
    }
  );

  return retryAfterSeconds > 0
    ? { retryAfterSeconds }
    : { code };
}

export async function discardOtp(
  phoneNumber: string,
  code: string
): Promise<void> {
  const smsAdminDb = getSmsAdminDb();

  const ref = smsAdminDb
    .collection("smsOtpChallenges")
    .doc(phoneNumber);

  const expectedHash = hashOtp(phoneNumber, code);

  await smsAdminDb.runTransaction(
    async (transaction: Transaction) => {
      const challenge = await transaction.get(ref);

      if (challenge.get("codeHash") === expectedHash) {
        transaction.delete(ref);
      }
    }
  );
}

export async function verifyOtp(
  phoneNumber: string,
  submittedCode: string
): Promise<
  "verified" | "invalid" | "expired" | "locked"
> {
  const smsAdminDb = getSmsAdminDb();

  const ref = smsAdminDb
    .collection("smsOtpChallenges")
    .doc(phoneNumber);

  return smsAdminDb.runTransaction(
    async (transaction: Transaction) => {
      const challenge = await transaction.get(ref);

      if (!challenge.exists) {
        return "invalid";
      }

      const expiresAt = challenge.get("expiresAt") as Timestamp;

      if (expiresAt.toMillis() <= Date.now()) {
        transaction.delete(ref);
        return "expired";
      }

      const attempts = Number(
        challenge.get("attempts") ?? 0
      );

      if (attempts >= MAX_ATTEMPTS) {
        transaction.delete(ref);
        return "locked";
      }

      const storedHash = challenge.get("codeHash");
      const submittedHash = hashOtp(
        phoneNumber,
        submittedCode
      );

      const valid =
        typeof storedHash === "string" &&
        timingSafeEqual(
          Buffer.from(storedHash, "hex"),
          Buffer.from(submittedHash, "hex")
        );

      if (valid) {
        transaction.delete(ref);
        return "verified";
      }

      if (attempts + 1 >= MAX_ATTEMPTS) {
        transaction.delete(ref);
        return "locked";
      }

      transaction.update(ref, {
        attempts: attempts + 1,
      });

      return "invalid";
    }
  );
}

export async function reserveNotification(
  phoneNumber: string
): Promise<number> {
  const smsAdminDb = getSmsAdminDb();

  const ref = smsAdminDb
    .collection("smsNotificationRateLimits")
    .doc(phoneNumber);

  const now = Date.now();
  const cooldownMs = 60 * 1000;

  return smsAdminDb.runTransaction(
    async (transaction: Transaction) => {
      const previous = await transaction.get(ref);

      const lastSentAt = previous.get("lastSentAt") as
        | Timestamp
        | undefined;

      const remaining = lastSentAt
        ? cooldownMs - (now - lastSentAt.toMillis())
        : 0;

      if (remaining > 0) {
        return Math.ceil(remaining / 1000);
      }

      transaction.set(ref, {
        lastSentAt: Timestamp.fromMillis(now),
      });

      return 0;
    }
  );
}