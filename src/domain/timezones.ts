import { ValidationError } from "./validation";
export interface WallTimeInput {
  date: string;
  time: string;
  timeZone: string;
  disambiguation?: "reject" | "earlier" | "later";
  gapPolicy?: "reject" | "shift-forward";
}
export interface ResolvedWallTime {
  startsAt: string;
  timeZone: string;
  wallTime: string;
  offsetMinutes: number;
  ambiguous: boolean;
  shifted: boolean;
  resolverVersion: "intl-offset-v1";
}
function formatter(zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ValidationError("올바른 IANA 시간대를 선택하세요.");
  }
}
function localStamp(format: Intl.DateTimeFormat, time: number): number {
  const parts = Object.fromEntries(
    format.formatToParts(new Date(time)).map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}
/** Uses the host ICU time-zone database; its version must be recorded alongside materialized slots. */
export function resolveWallTime(input: WallTimeInput): ResolvedWallTime {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    !/^\d{2}:\d{2}$/.test(input.time) ||
    typeof input.timeZone !== "string" ||
    input.timeZone.length > 100
  )
    throw new ValidationError("현지 날짜·시간·시간대를 확인하세요.");
  const wall = `${input.date}T${input.time}:00`,
    nominal = Date.parse(`${wall}Z`);
  if (
    !Number.isFinite(nominal) ||
    new Date(nominal).toISOString().slice(0, 19) !== wall
  )
    throw new ValidationError("존재하는 현지 날짜와 시간을 입력하세요.");
  const format = formatter(input.timeZone),
    offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 3) {
    const timestamp = nominal + hour * 3600000;
    offsets.add(localStamp(format, timestamp) - timestamp);
  }
  const candidates = [...offsets]
      .map((offset) => nominal - offset)
      .filter((timestamp) => localStamp(format, timestamp) === nominal)
      .sort((a, b) => a - b),
    disambiguation = input.disambiguation ?? "reject",
    gapPolicy = input.gapPolicy ?? "reject";
  if (
    !["reject", "earlier", "later"].includes(disambiguation) ||
    !["reject", "shift-forward"].includes(gapPolicy)
  )
    throw new ValidationError("시간 중복·공백 처리 방식을 확인하세요.");
  if (candidates.length > 1 && disambiguation === "reject")
    throw new ValidationError(
      "이 현지 시간은 두 번 존재합니다. 먼저 또는 나중 시간을 선택하세요.",
    );
  let chosen =
      candidates[disambiguation === "later" ? candidates.length - 1 : 0],
    shifted = false;
  if (chosen === undefined) {
    if (gapPolicy === "reject")
      throw new ValidationError(
        "시간대 변경으로 존재하지 않는 현지 시간입니다. 다른 시간 또는 앞으로 이동을 선택하세요.",
      );
    const after = [...offsets]
      .map((offset) => nominal - offset)
      .filter((timestamp) => localStamp(format, timestamp) > nominal)
      .sort((a, b) => localStamp(format, a) - localStamp(format, b));
    chosen = after[0];
    shifted = true;
  }
  if (chosen === undefined)
    throw new ValidationError("시간을 해석할 수 없습니다.");
  return {
    startsAt: new Date(chosen).toISOString(),
    timeZone: format.resolvedOptions().timeZone,
    wallTime: wall,
    offsetMinutes: (localStamp(format, chosen) - chosen) / 60000,
    ambiguous: candidates.length > 1,
    shifted,
    resolverVersion: "intl-offset-v1",
  };
}
