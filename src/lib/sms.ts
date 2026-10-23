import { randomInt } from "node:crypto";

const IPROGSMS_MESSAGES_URL =
  "https://www.iprogsms.com/api/v1/sms_messages";

export function normalizePhilippinePhoneNumber(
  input: string
): string | null {
  const compact = input.trim().replace(/[\s()-]/g, "");

  if (/^09\d{9}$/.test(compact)) {
    return `+63${compact.slice(1)}`;
  }

  if (/^\+639\d{9}$/.test(compact)) {
    return compact;
  }

  if (/^639\d{9}$/.test(compact)) {
    return `+${compact}`;
  }

  return null;
}

async function sendIprogSms(
  phoneNumber: string,
  message: string
): Promise<void> {
  const normalizedNumber =
    normalizePhilippinePhoneNumber(phoneNumber);

  if (!normalizedNumber) {
    throw new Error(
      "Enter a valid Philippine mobile number."
    );
  }

  const trimmedMessage = message.trim();

  if (!trimmedMessage || trimmedMessage.length > 1000) {
    throw new Error(
      "SMS message must contain 1 to 1000 characters."
    );
  }

  const apiKey = process.env.IPROGSMS_API_KEY;

  if (!apiKey) {
    throw new Error(
      "IPROGSMS_API_KEY is not configured."
    );
  }

  const payload = {
    api_token: apiKey,
    phone_number: normalizedNumber.slice(1),
    message: trimmedMessage,
  };

  let response: Response;

  try {
    response = await fetch(IPROGSMS_MESSAGES_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("iProgSMS connection failed:", error);
    throw new Error(
      "Could not connect to the SMS provider."
    );
  }

  const responseText = await response.text();

  console.info("iProgSMS response:", {
    status: response.status,
    body: responseText,
  });

  let data: unknown;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      "SMS provider returned an invalid response."
    );
  }

  if (!response.ok) {
    console.error(
      "iProgSMS rejected the request:",
      response.status,
      data
    );

    throw new Error(
      "SMS provider rejected the request."
    );
  }

  if (
    !data ||
    typeof data !== "object" ||
    !("status" in data) ||
    data.status !== 200
  ) {
    console.error(
      "Unexpected iProgSMS response:",
      data
    );

    throw new Error(
      "SMS provider could not queue the message."
    );
  }
}

export async function sendSMSNotification(
  phoneNumber: string,
  message: string
): Promise<void> {
  await sendIprogSms(phoneNumber, message);
}

export async function sendVerificationOtp(
  phoneNumber: string,
  code: string
): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    throw new Error(
      "Verification code must contain 6 digits."
    );
  }

  await sendIprogSms(
    phoneNumber,
    `MediServe verification code: ${code}. It expires in 5 minutes.`
  );
}

export function generateOtp(): string {
  return randomInt(0, 1000000)
    .toString()
    .padStart(6, "0");
}