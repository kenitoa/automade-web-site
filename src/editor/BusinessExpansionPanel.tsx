import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BookingHoliday,
  BookingRecurrence,
  BookingWaitlistEntry,
  ExpansionJobResult,
  OrderFulfillment,
} from "../domain/expansion";
import { api } from "../infrastructure/api";
import { record } from "../domain/validation";
import type { BookingChangeReview } from "../domain/advancement";
import type { StudioState } from "./useStudio";
import type { ExpansionState } from "./useExpansion";
import EditorDialog from "./EditorDialog";

function bookingConflict(code: string): string {
  return (
    (
      {
        CONFIRMED_OR_OFFERED_CAPACITY:
          "확정·제안 인원이 변경 정원을 초과합니다.",
        WAITLIST_QUANTITY: "대기 신청 인원이 변경 정원을 초과합니다.",
        ACTIVE_RESERVATIONS: "예약·제안·대기가 남은 자원은 중지할 수 없습니다.",
        HOLIDAY_RESERVATIONS: "이 날짜에 확정·제안 예약이 있습니다.",
        HOLIDAY_WAITLIST: "이 날짜에 대기 신청이 있습니다.",
      } as Record<string, string>
    )[code] ?? code
  );
}
function RuleFields({
  resources,
  rule,
}: {
  resources: { id: string; name: string; capacity: number }[];
  rule?: BookingRecurrence;
}) {
  return (
    <>
      <label>
        규칙 이름
        <input name="name" required maxLength={100} defaultValue={rule?.name} />
      </label>
      <label>
        자원
        <select
          name="resourceId"
          defaultValue={rule?.resourceId}
          disabled={Boolean(rule)}
        >
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.name} (정원 {resource.capacity})
            </option>
          ))}
        </select>
      </label>
      {rule && (
        <input name="resourceId" type="hidden" value={rule.resourceId} />
      )}
      <label>
        시작 날짜
        <input
          name="startDate"
          type="date"
          required
          defaultValue={rule?.startDate}
        />
      </label>
      <label>
        종료 날짜
        <input
          name="endDate"
          type="date"
          required
          defaultValue={rule?.endDate}
        />
      </label>
      <label>
        시작 현지 시각
        <input
          name="startTime"
          type="time"
          required
          defaultValue={rule?.startTime ?? "09:00"}
        />
      </label>
      <label>
        IANA 시간대
        <input
          name="timeZone"
          required
          maxLength={100}
          defaultValue={rule?.timeZone ?? "UTC"}
          placeholder="Asia/Seoul"
        />
      </label>
      <label>
        서머타임 중복 시각
        <select
          name="disambiguation"
          defaultValue={rule?.disambiguation ?? "reject"}
        >
          <option value="reject">생성 보류</option>
          <option value="earlier">이른 시각</option>
          <option value="later">늦은 시각</option>
        </select>
      </label>
      <label>
        서머타임 없는 시각
        <select name="gapPolicy" defaultValue={rule?.gapPolicy ?? "reject"}>
          <option value="reject">생성 보류</option>
          <option value="shift-forward">공백 이후로 이동</option>
        </select>
      </label>
      <label>
        시간(분)
        <input
          name="durationMinutes"
          type="number"
          min={5}
          max={1440}
          defaultValue={rule?.durationMinutes ?? 60}
          required
        />
      </label>
      <label>
        정원
        <input
          name="capacity"
          type="number"
          min={1}
          max={10000}
          defaultValue={rule?.capacity ?? 1}
          required
        />
      </label>
      <fieldset>
        <legend>현지 반복 요일</legend>
        {["일", "월", "화", "수", "목", "금", "토"].map((day, index) => (
          <label key={day}>
            <input
              type="checkbox"
              name="weekdays"
              value={index}
              defaultChecked={rule?.weekdays.includes(index) ?? false}
            />
            {day}
          </label>
        ))}
      </fieldset>
    </>
  );
}

export default function BusinessExpansionPanel({
  studio: s,
  expansion: x,
}: {
  studio: StudioState;
  expansion: ExpansionState;
}) {
  const [rules, setRules] = useState<BookingRecurrence[]>([]),
    [holidays, setHolidays] = useState<BookingHoliday[]>([]),
    [waiting, setWaiting] = useState<BookingWaitlistEntry[]>([]),
    [resources, setResources] = useState<
      Array<{ id: string; name: string; capacity: number; active: boolean }>
    >([]),
    [orders, setOrders] = useState<Array<{ id: string; status: string }>>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<{
      title: string;
      path: string;
      method: string;
      body: Record<string, unknown>;
      booking?: BookingChangeReview;
      proposed?: Record<string, unknown>;
    } | null>(null);
  const writable = x.can("data.write"),
    readable = x.can("data.read"),
    query = new URLSearchParams({
      projectId: s.project.id,
      ...(x.scope?.environmentId
        ? { environmentId: x.scope.environmentId }
        : {}),
    });
  const [fulfillments, setFulfillments] = useState<OrderFulfillment[]>([]),
    sequence = useRef(0);
  const scopeKey = `${s.project.id}/${x.environmentId}`,
    currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  function list(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) throw new Error("목록 응답을 확인하세요.");
    return value.map(record);
  }
  async function refresh() {
    if (!x.scope || !readable) {
      setRules([]);
      setHolidays([]);
      setWaiting([]);
      setResources([]);
      setOrders([]);
      return;
    }
    setBusy(true);
    setError("");
    const request = ++sequence.current;
    try {
      const result = await Promise.all([
        x.request<unknown>("booking/rules"),
        x.request<unknown>("booking/holidays"),
        x.request<unknown>("booking/waitlist"),
        api<unknown>(`/api/platform/booking/resources?${query}`),
        api<unknown>(`/api/platform/orders?${query}`),
        x.request<unknown>("orders/fulfillments"),
      ]);
      if (request !== sequence.current) return;
      setRules(
        list(result[0]).map((row) => {
          if (
            typeof row.id !== "string" ||
            typeof row.name !== "string" ||
            !Array.isArray(row.weekdays) ||
            row.weekdays.some((value) => typeof value !== "number") ||
            typeof row.startDate !== "string" ||
            typeof row.endDate !== "string" ||
            typeof row.startTime !== "string"
          )
            throw new Error("반복 규칙 응답을 확인하세요.");
          return {
            id: row.id,
            name: row.name,
            projectId: String(row.projectId),
            resourceId: String(row.resourceId),
            startDate: row.startDate,
            endDate: row.endDate,
            weekdays: row.weekdays as number[],
            startTime: row.startTime,
            durationMinutes: Number(row.durationMinutes),
            capacity: Number(row.capacity),
            enabled: Boolean(row.enabled),
            createdAt: String(row.createdAt),
            timeZone: typeof row.timeZone === "string" ? row.timeZone : "UTC",
            disambiguation:
              row.disambiguation === "earlier" || row.disambiguation === "later"
                ? row.disambiguation
                : "reject",
            gapPolicy:
              row.gapPolicy === "shift-forward" ? "shift-forward" : "reject",
            revision: Number(row.revision ?? 1),
          };
        }),
      );
      setHolidays(
        list(result[1]).map((row) => ({
          resourceId: String(row.resourceId),
          date: String(row.date),
          reason: String(row.reason),
        })),
      );
      setWaiting(
        list(result[2]).map((row) => {
          if (
            ![
              "waiting",
              "offered",
              "accepted",
              "cancelled",
              "expired",
            ].includes(String(row.status))
          )
            throw new Error("대기 상태 응답을 확인하세요.");
          return {
            id: String(row.id),
            slotId: String(row.slotId),
            accountId: String(row.accountId),
            quantity: Number(row.quantity),
            status: row.status as BookingWaitlistEntry["status"],
            offerExpiresAt:
              row.offerExpiresAt === null ? null : Number(row.offerExpiresAt),
            bookingId: row.bookingId === null ? null : String(row.bookingId),
            createdAt: String(row.createdAt),
          };
        }),
      );
      setResources(
        list(result[3]).map((row) => ({
          id: String(row.id),
          name: String(row.name),
          capacity: Number(row.capacity),
          active: Boolean(row.active),
        })),
      );
      setOrders(
        list(result[4]).map((row) => ({
          id: String(row.id),
          status: String(row.status),
        })),
      );
      setFulfillments(
        list(result[5]).map((row) => {
          if (
            !["unfulfilled", "processing", "fulfilled", "returned"].includes(
              String(row.status),
            )
          )
            throw new Error("주문 처리 상태를 확인하세요.");
          return {
            orderId: String(row.orderId),
            projectId: String(row.projectId),
            status: row.status as OrderFulfillment["status"],
            tracking: String(row.tracking),
            notes: String(row.notes),
            updatedBy: String(row.updatedBy),
            updatedAt: String(row.updatedAt),
          };
        }),
      );
    } catch (e) {
      if (request === sequence.current)
        setError(
          e instanceof Error ? e.message : "예약 운영 정보를 확인하세요.",
        );
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    setReview(null);
    setRules([]);
    setWaiting([]);
    setHolidays([]);
    setResources([]);
    setOrders([]);
    setFulfillments([]);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [s.project.id, x.scope?.environmentId, readable]);
  function propose(
    event: FormEvent<HTMLFormElement>,
    kind: "rule" | "holiday" | "fulfillment",
    existing?: BookingRecurrence,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      value = (key: string): string => String(data.get(key) ?? "");
    if (kind === "rule") {
      const body = {
        name: value("name"),
        resourceId: value("resourceId"),
        startDate: value("startDate"),
        endDate: value("endDate"),
        startTime: value("startTime"),
        timeZone: value("timeZone"),
        disambiguation: value("disambiguation"),
        gapPolicy: value("gapPolicy"),
        durationMinutes: Number(value("durationMinutes")),
        capacity: Number(value("capacity")),
        weekdays: data.getAll("weekdays").map(Number),
        enabled: existing?.enabled ?? true,
      };
      if (existing) {
        void previewBooking("rule", existing.id, body, "반복 규칙");
        return;
      }
      setReview({
        title: "반복 예약 규칙 저장 검토",
        path: "booking/rules",
        method: "POST",
        body,
      });
    } else if (kind === "holiday")
      void previewBooking(
        "holiday",
        value("resourceId"),
        {
          date: value("date"),
          reason: value("reason"),
        },
        "휴일 추가",
      );
    else
      setReview({
        title: "주문 후처리 변경 검토",
        path: `orders/${encodeURIComponent(value("orderId"))}/fulfillment`,
        method: "PUT",
        body: {
          status: value("status"),
          tracking: value("tracking"),
          notes: value("notes"),
        },
      });
  }
  async function previewBooking(
    kind: "resource" | "rule" | "holiday",
    targetId: string,
    input: Record<string, unknown>,
    label: string,
  ) {
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      const result = await x.request<BookingChangeReview>(
        "booking/reviews",
        "POST",
        { kind, targetId, input },
      );
      if (scope !== currentScope.current) return;
      if (
        !result.id ||
        !result.approvalFingerprint ||
        !Array.isArray(result.conflicts) ||
        !Number.isFinite(Date.parse(result.expiresAt))
      )
        throw new Error("예약 영향 검토 응답을 확인하세요.");
      setReview({
        title: `${label} 영향 검토`,
        path: `booking/reviews/${encodeURIComponent(result.id)}/apply`,
        method: "POST",
        body: { approvalFingerprint: result.approvalFingerprint },
        booking: result,
        proposed: input,
      });
    } catch (e) {
      if (scope === currentScope.current)
        setError(
          e instanceof Error ? e.message : "예약 변경을 검토하지 못했습니다.",
        );
    } finally {
      if (scope === currentScope.current) setBusy(false);
    }
  }
  async function apply() {
    if (!review) return;
    if (
      review.booking &&
      (review.booking.conflicts.length ||
        Date.parse(review.booking.expiresAt) <= Date.now())
    ) {
      setError("예약 충돌을 처리하거나 만료된 변경을 다시 검토하세요.");
      return;
    }
    const scope = scopeKey;
    setBusy(true);
    setError("");
    try {
      await x.request<OrderFulfillment | unknown>(
        review.path,
        review.method,
        review.body,
      );
      if (scope !== currentScope.current) return;
      setReview(null);
      s.setMessage("운영 변경을 저장했습니다.");
      await refresh();
    } catch (e) {
      if (scope === currentScope.current)
        setError(
          e instanceof Error ? e.message : "운영 변경을 저장하지 못했습니다.",
        );
    } finally {
      if (scope === currentScope.current) setBusy(false);
    }
  }
  async function enqueue(path: string) {
    setBusy(true);
    setError("");
    try {
      const job = await x.request<ExpansionJobResult>(path, "POST", {
        key: crypto.randomUUID(),
      });
      s.setMessage(
        `예약 작업을 등록했습니다: ${job.id}. 작업 목록에서 결과를 확인하세요.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  if (!x.scope)
    return <p className="hint">서버에 저장한 사이트와 환경을 선택하세요.</p>;
  if (!readable)
    return <p className="hint">예약·주문 데이터를 읽을 권한이 필요합니다.</p>;
  return (
    <section aria-label="예약 확장과 주문 후처리">
      <button disabled={busy} onClick={() => void refresh()}>
        운영 목록 새로고침
      </button>
      {busy && <p role="status">운영 정보를 처리하고 있습니다.</p>}
      {error && <p role="alert">{error}</p>}
      <h3>반복 예약</h3>
      <p className="hint">
        선택한 IANA 시간대의 현지 요일·시각으로 최대 180일을 생성하고 UTC로
        보관합니다. 서머타임 중복·공백은 명시한 정책으로 처리합니다. 규칙을
        바꿔도 이미 생성한 일정은 보존하며 정원·휴일 변경 전에 확정
        예약·제안·대기 인원을 검토합니다.
      </p>
      {!resources.length && (
        <p>
          예약 자원이 없습니다. 기존 운영의 예약 설정에서 자원을 먼저
          추가하세요.
        </p>
      )}
      {writable && resources.length > 0 && (
        <form onSubmit={(event) => propose(event, "rule")}>
          <RuleFields resources={resources} />
          <button disabled={busy}>저장 검토</button>
        </form>
      )}
      {!rules.length ? (
        <p>반복 규칙이 없습니다.</p>
      ) : (
        <ul>
          {rules.map((rule) => (
            <li key={rule.id}>
              {rule.name} · {rule.startDate}~{rule.endDate} · {rule.startTime}{" "}
              {rule.timeZone ?? "UTC"} / {rule.durationMinutes}분 · 정원{" "}
              {rule.capacity} · {rule.enabled ? "활성" : "중지"}
              {writable && (
                <>
                  <button
                    disabled={busy || !rule.enabled}
                    onClick={() =>
                      void enqueue(`booking/rules/${rule.id}/materialize`)
                    }
                  >
                    시간 생성 작업 등록
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void previewBooking(
                        "rule",
                        rule.id,
                        { ...rule, enabled: !rule.enabled },
                        "반복 규칙 활성화 변경",
                      )
                    }
                  >
                    {rule.enabled ? "규칙 중지 검토" : "규칙 활성화 검토"}
                  </button>
                  <details>
                    <summary>기존 규칙 수정·시간대 검토</summary>
                    <form onSubmit={(event) => propose(event, "rule", rule)}>
                      <RuleFields resources={resources} rule={rule} />
                      <button disabled={busy}>기존 규칙 변경 영향 검토</button>
                    </form>
                  </details>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>예약 자원 정원·사용 상태</h3>
      {resources.map((resource) => (
        <article className="page-card" key={resource.id}>
          <strong>
            {resource.name} · 정원 {resource.capacity} ·{" "}
            {resource.active ? "사용 중" : "중지"}
          </strong>
          {writable && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const input = new FormData(event.currentTarget);
                void previewBooking(
                  "resource",
                  resource.id,
                  {
                    name: String(input.get("name")),
                    capacity: Number(input.get("capacity")),
                    active: input.get("active") === "on",
                  },
                  "자원 정원·사용 상태 변경",
                );
              }}
            >
              <label>
                자원 이름
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={resource.name}
                />
              </label>
              <label>
                변경 정원
                <input
                  name="capacity"
                  type="number"
                  min={1}
                  max={10000}
                  required
                  defaultValue={resource.capacity}
                />
              </label>
              <label className="check">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={resource.active}
                />
                자원 사용
              </label>
              <button disabled={busy}>자원 변경 영향 검토</button>
            </form>
          )}
        </article>
      ))}
      <h3>휴일</h3>
      {writable && resources.length > 0 && (
        <form onSubmit={(event) => propose(event, "holiday")}>
          <label>
            자원
            <select name="resourceId">
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            휴일 현지 날짜
            <input name="date" type="date" required />
          </label>
          <label>
            사유
            <input name="reason" maxLength={1000} />
          </label>
          <button disabled={busy}>휴일 추가 검토</button>
        </form>
      )}
      {!holidays.length ? (
        <p>등록된 휴일이 없습니다.</p>
      ) : (
        <ul>
          {holidays.map((day) => (
            <li key={day.resourceId + day.date}>
              {day.date} ·{" "}
              {resources.find((resource) => resource.id === day.resourceId)
                ?.name ?? day.resourceId}{" "}
              · {day.reason}
              {writable && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void previewBooking(
                      "holiday",
                      day.resourceId,
                      { date: day.date, remove: true },
                      "휴일 제거",
                    )
                  }
                >
                  제거 검토
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>예약 대기</h3>
      <p className="hint">
        빈 정원을 확인해 제안하면 방문자가 10분 안에 수락할 수 있습니다. 제안
        정원은 다른 예약에서 제외됩니다.
      </p>
      {writable && (
        <button
          disabled={busy}
          onClick={() => void enqueue("booking/waitlist/offers")}
        >
          대기 제안 작업 등록
        </button>
      )}
      {!waiting.length ? (
        <p>예약 대기가 없습니다.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>대기 ID</th>
              <th>인원</th>
              <th>상태</th>
              <th>제안 만료 UTC</th>
            </tr>
          </thead>
          <tbody>
            {waiting.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.id}</td>
                <td>{entry.quantity}</td>
                <td>{entry.status}</td>
                <td>
                  {entry.offerExpiresAt
                    ? new Date(entry.offerExpiresAt).toISOString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>주문 후처리</h3>
      <p className="hint">
        결제 상태는 공급자 확인으로 결정됩니다. 여기서는 확인된 주문의
        처리·배송·반품 기록을 관리합니다.
      </p>
      {!orders.length ? (
        <p>주문이 없습니다.</p>
      ) : (
        writable && (
          <form onSubmit={(event) => propose(event, "fulfillment")}>
            <label>
              주문
              <select name="orderId">
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.id} · {order.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              후처리 상태
              <select name="status">
                <option value="unfulfilled">미처리</option>
                <option value="processing">처리 중</option>
                <option value="fulfilled">처리 완료</option>
                <option value="returned">반품 기록</option>
              </select>
            </label>
            <label>
              송장·추적 번호
              <input name="tracking" maxLength={200} />
            </label>
            <label>
              처리 메모
              <textarea name="notes" maxLength={2000} />
            </label>
            <button disabled={busy}>후처리 저장 검토</button>
          </form>
        )
      )}
      {fulfillments.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>주문 ID</th>
              <th>후처리</th>
              <th>추적 번호</th>
              <th>처리 메모</th>
            </tr>
          </thead>
          <tbody>
            {fulfillments.map((item) => (
              <tr key={item.orderId}>
                <td>{item.orderId}</td>
                <td>{item.status}</td>
                <td>{item.tracking || "—"}</td>
                <td>{item.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {review && (
        <EditorDialog
          title={review.title}
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <p>선택한 환경의 운영 데이터에 다음 변경을 저장합니다.</p>
          <pre>{JSON.stringify(review.proposed ?? review.body, null, 2)}</pre>
          {review.booking && (
            <>
              <p>
                검토 만료 {new Date(review.booking.expiresAt).toLocaleString()}{" "}
                · 생성 일정 {review.booking.affected.slots}개 · 확정{" "}
                {review.booking.affected.confirmed}명 · 제안{" "}
                {review.booking.affected.offered}명 · 대기{" "}
                {review.booking.affected.waiting}건
              </p>
              <p>
                이미 생성한 반복 일정의 시각은 바꾸지 않습니다. 검토 뒤
                예약·대기·일정이 바뀌면 서버가 적용을 보류합니다.
              </p>
              {review.booking.conflicts.map((conflict) => (
                <p role="alert" className="bad" key={conflict}>
                  {bookingConflict(conflict)}
                </p>
              ))}
            </>
          )}
          <button
            disabled={
              busy ||
              Boolean(
                review.booking &&
                (review.booking.conflicts.length ||
                  Date.parse(review.booking.expiresAt) <= Date.now()),
              )
            }
            onClick={() => void apply()}
          >
            검토한 변경 저장
          </button>
          <button disabled={busy} onClick={() => setReview(null)}>
            취소
          </button>
        </EditorDialog>
      )}
    </section>
  );
}
