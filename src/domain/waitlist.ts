import type { BookingWaitlistEntry } from "./expansion";
import { record, ValidationError } from "./validation";

const states: BookingWaitlistEntry["status"][] = [
  "waiting",
  "offered",
  "accepted",
  "cancelled",
  "expired",
];
/** Validate the shared visitor API contract before rendering personal booking data. */
export function parseWaitlistEntries(value: unknown): BookingWaitlistEntry[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new ValidationError("예약 대기 목록 형식을 확인하지 못했습니다.");
  return value.map((item) => {
    const entry = record(item);
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.slotId !== "string" ||
      !entry.slotId ||
      typeof entry.accountId !== "string" ||
      !entry.accountId ||
      !Number.isSafeInteger(entry.quantity) ||
      Number(entry.quantity) < 1 ||
      Number(entry.quantity) > 10000 ||
      !states.includes(entry.status as BookingWaitlistEntry["status"]) ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      (entry.bookingId !== null && typeof entry.bookingId !== "string") ||
      (entry.offerExpiresAt !== null &&
        (!Number.isSafeInteger(entry.offerExpiresAt) ||
          Number(entry.offerExpiresAt) <= 0)) ||
      (entry.status === "offered" && entry.offerExpiresAt === null)
    )
      throw new ValidationError("예약 대기 목록 형식을 확인하지 못했습니다.");
    return {
      id: entry.id,
      slotId: entry.slotId,
      accountId: entry.accountId,
      quantity: Number(entry.quantity),
      status: entry.status as BookingWaitlistEntry["status"],
      offerExpiresAt:
        entry.offerExpiresAt === null ? null : Number(entry.offerExpiresAt),
      bookingId: entry.bookingId as string | null,
      createdAt: entry.createdAt,
    };
  });
}
/** A GET may still return offered until the durable offer job marks an elapsed hold expired. */
export function visibleWaitlistState(
  entry: BookingWaitlistEntry,
  now: number,
): BookingWaitlistEntry["status"] {
  return entry.status === "offered" &&
    (entry.offerExpiresAt === null || entry.offerExpiresAt <= now)
    ? "expired"
    : entry.status;
}
export function waitlistStatusLabel(
  status: BookingWaitlistEntry["status"],
): string {
  return {
    waiting: "대기 중",
    offered: "예약 제안 도착",
    accepted: "예약 확정",
    cancelled: "대기 취소됨",
    expired: "예약 제안 만료",
  }[status];
}
