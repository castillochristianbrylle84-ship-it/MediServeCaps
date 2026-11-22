const QUEUE_OPEN_MINUTE = 8 * 60;
const QUEUE_CLOSE_MINUTE = 17 * 60;
const QUEUE_TIME_ZONE = "Asia/Manila";

export function isQueueRegistrationOpen(date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: QUEUE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const currentMinute = hour * 60 + minute;

  return currentMinute >= QUEUE_OPEN_MINUTE && currentMinute < QUEUE_CLOSE_MINUTE;
}

export const QUEUE_REGISTRATION_HOURS_MESSAGE =
  "Queue numbers are available from 8:00 AM to 5:00 PM Philippine time.";
