import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../infrastructure/api";
import PlatformBillingPanel from "./PlatformBillingPanel";
interface Account {
  id: string;
  email: string;
  displayName: string;
}
interface Session {
  account: Account | null;
  csrf: string;
  localOwner: boolean;
}
interface Member {
  id: string;
  email: string;
  displayName: string;
  role: string;
}
interface Invite {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: number;
}
interface Connection {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  secretRef: string;
  configured: boolean;
  paused: boolean;
  lastStatus: string;
}
interface Review {
  id: string;
  revision: number;
  status: string;
  comments: Array<{ id: string; body: string; authorId: string }>;
}
interface Product {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  inventory: number;
  updatedAt: string;
  active: number;
}
interface Order {
  id: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: string;
}
interface Resource {
  id: string;
  name: string;
  capacity: number;
}
interface Slot {
  id: string;
  resourceId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  available: number;
}
interface Booking {
  id: string;
  name: string;
  startsAt: string;
  quantity: number;
  status: string;
}
interface Outbox {
  id: string;
  eventKey: string;
  status: string;
  attempts: number;
  errorCode: string | null;
}
type MappedRow = Record<string, string | number | boolean | null>;
interface MappedData {
  rows: MappedRow[];
  cached: boolean;
  fetchedAt: string;
}
function mappedData(value: unknown): MappedData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("데이터 응답 형식을 확인하세요.");
  const data = value as Record<string, unknown>;
  if (
    !Array.isArray(data.rows) ||
    data.rows.length > 1000 ||
    typeof data.cached !== "boolean" ||
    typeof data.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(data.fetchedAt))
  )
    throw new Error("데이터 응답의 행·조회 시각을 확인하세요.");
  const rows: MappedRow[] = data.rows.map((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).length > 50
    )
      throw new Error("매핑된 데이터 행 형식을 확인하세요.");
    const result: MappedRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        (value !== null &&
          !["string", "number", "boolean"].includes(typeof value)) ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "string" && value.length > 5000)
      )
        throw new Error(
          "매핑된 값은 안전한 필드 이름과 문자열·숫자·참/거짓이어야 합니다.",
        );
      result[key] = value as string | number | boolean | null;
    }
    return result;
  });
  return { rows, cached: data.cached, fetchedAt: data.fetchedAt };
}
type Tab =
  | "accounts"
  | "team"
  | "reviews"
  | "connections"
  | "commerce"
  | "booking"
  | "billing";
const tabs: Array<[Tab, string]> = [
  ["accounts", "계정"],
  ["team", "팀·권한"],
  ["reviews", "검토"],
  ["connections", "연결·발송"],
  ["commerce", "상품·주문"],
  ["booking", "예약"],
  ["billing", "플랜·사용량"],
];
const value = (form: FormData, key: string): string =>
  String(form.get(key) ?? "");
export default function PlatformPanel({
  projectId,
  onMessage,
  onImportData,
}: {
  projectId: string;
  onMessage: (message: string) => void;
  onImportData?: (rows: MappedRow[]) => void;
}) {
  const [tab, setTab] = useState<Tab>("accounts"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [current, setCurrent] = useState<Session | null>(null),
    [members, setMembers] = useState<Member[]>([]),
    [invites, setInvites] = useState<Invite[]>([]),
    [token, setToken] = useState("");
  const [reviews, setReviews] = useState<Review[]>([]),
    [connections, setConnections] = useState<Connection[]>([]),
    [outbox, setOutbox] = useState<Outbox[]>([]),
    [dataPreview, setDataPreview] = useState<MappedData | null>(null);
  const [products, setProducts] = useState<Product[]>([]),
    [orders, setOrders] = useState<Order[]>([]),
    [resources, setResources] = useState<Resource[]>([]),
    [slots, setSlots] = useState<Slot[]>([]),
    [bookings, setBookings] = useState<Booking[]>([]);
  const [billing, setBilling] = useState<{
      plan: string;
      limits: Record<string, number>;
      remoteBillingVerified: boolean;
    } | null>(null),
    [usage, setUsage] = useState<Array<{ metric: string; value: number }>>([]);
  const request = useCallback(
    <T,>(path: string, method = "GET", body?: unknown): Promise<T> =>
      api<T>(
        `/api/platform/${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`,
        method,
        body,
      ),
    [projectId],
  );
  const load = useCallback(async () => {
    const user = await request<Session>("session");
    setCurrent(user);
    if (tab === "team") {
      const access = await request<{ members: Member[]; invites: Invite[] }>(
        "access",
      );
      setMembers(access.members);
      setInvites(access.invites);
    }
    if (tab === "reviews") setReviews(await request<Review[]>("reviews"));
    if (tab === "connections") {
      const [links, deliveries] = await Promise.all([
        request<Connection[]>("connections"),
        request<Outbox[]>("outbox"),
      ]);
      setConnections(links);
      setOutbox(deliveries);
    }
    if (tab === "commerce") {
      const [items, purchases, links] = await Promise.all([
        request<Product[]>("catalog"),
        request<Order[]>("orders"),
        request<Connection[]>("connections"),
      ]);
      setProducts(items);
      setOrders(purchases);
      setConnections(links);
    }
    if (tab === "booking") {
      const [items, times, reservations] = await Promise.all([
        request<Resource[]>("booking/resources"),
        request<Slot[]>("booking/slots"),
        request<Booking[]>("bookings"),
      ]);
      setResources(items);
      setSlots(times);
      setBookings(reservations);
    }
    if (tab === "billing") {
      const [plan, counters] = await Promise.all([
        request<{
          plan: string;
          limits: Record<string, number>;
          remoteBillingVerified: boolean;
        }>("billing"),
        request<{ metrics: Array<{ metric: string; value: number }> }>("usage"),
      ]);
      setBilling(plan);
      setUsage(counters.metrics);
    }
  }, [request, tab]);
  const run = useCallback(
    async (action: () => Promise<unknown>, success = "저장했습니다.") => {
      setBusy(true);
      setMessage("");
      try {
        await action();
        await load();
        setMessage(success);
        onMessage(success);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "요청을 처리하지 못했습니다.";
        setMessage(message);
        onMessage(message);
      } finally {
        setBusy(false);
      }
    },
    [load, onMessage],
  );
  useEffect(() => {
    let active = true;
    setToken("");
    setDataPreview(null);
    load().catch((error: unknown) => {
      if (active)
        setMessage(
          error instanceof Error
            ? error.message
            : "운영 정보를 불러오지 못했습니다.",
        );
    });
    return () => {
      active = false;
    };
  }, [load]);
  const submit =
    (action: (data: FormData) => Promise<unknown>, success?: string) =>
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      void run(async () => {
        const result = await action(new FormData(form));
        form.reset();
        return result;
      }, success);
    };
  return (
    <section className="platform-panel" aria-label="사이트 서비스 관리">
      <h3>사이트 서비스</h3>
      <p>
        선택한 사이트의 실제 계정·운영 데이터를 관리합니다. 외부 발송·결제는
        공급자 설정과 별도 검증이 필요합니다.
      </p>
      <div className="segments" role="tablist" aria-label="서비스 관리 탭">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite">
        {busy ? "처리 중…" : message}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(load, "최신 정보를 확인했습니다.")}
      >
        새로고침
      </button>
      {tab === "accounts" && (
        <div>
          <p>
            {current?.account
              ? `${current.account.displayName} · ${current.account.email}`
              : "사이트 회원으로 로그인하지 않았습니다."}
            {current?.localOwner ? " · 로컬 소유자 관리" : ""}
          </p>
          {!current?.account ? (
            <>
              <form
                onSubmit={submit(
                  (form) =>
                    request("login", "POST", {
                      email: value(form, "email"),
                      password: value(form, "password"),
                    }),
                  "로그인했습니다.",
                )}
              >
                <h4>로그인</h4>
                <label>
                  이메일
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                  />
                </label>
                <label>
                  비밀번호
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <button disabled={busy}>로그인</button>
              </form>
              <form
                onSubmit={submit(
                  (form) =>
                    request("accounts", "POST", {
                      email: value(form, "email"),
                      password: value(form, "password"),
                      displayName: value(form, "displayName"),
                    }),
                  "계정을 생성했습니다. 로그인하세요.",
                )}
              >
                <h4>사이트 회원 생성</h4>
                <label>
                  이름
                  <input name="displayName" maxLength={100} required />
                </label>
                <label>
                  이메일
                  <input
                    type="email"
                    name="email"
                    autoComplete="username"
                    required
                  />
                </label>
                <label>
                  비밀번호
                  <input
                    type="password"
                    name="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button disabled={busy}>회원 생성</button>
              </form>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => request("logout", "POST", {}),
                  "로그아웃했습니다.",
                )
              }
            >
              로그아웃
            </button>
          )}
          <form
            onSubmit={submit(async (form) => {
              const result = await request<{
                message: string;
                localRecoveryToken?: string;
              }>("password-reset/request", "POST", {
                email: value(form, "email"),
              });
              setToken(result.localRecoveryToken ?? "");
              return result;
            }, "등록된 계정과 발송 연결이 있으면 복구 안내를 전달합니다.")}
          >
            <h4>비밀번호 복구</h4>
            <label>
              이메일
              <input name="email" type="email" required />
            </label>
            <button disabled={busy}>복구 안내 요청</button>
          </form>
          {token && (
            <label>
              로컬 복구 토큰 · 15분 만료
              <input value={token} readOnly aria-label="로컬 복구 토큰" />
            </label>
          )}
          <form
            onSubmit={submit(
              (form) =>
                request("password-reset/confirm", "POST", {
                  token: value(form, "token"),
                  password: value(form, "password"),
                }),
              "비밀번호를 변경하고 기존 세션을 폐기했습니다.",
            )}
          >
            <label>
              복구 토큰
              <input name="token" required />
            </label>
            <label>
              새 비밀번호
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <button disabled={busy}>비밀번호 변경</button>
          </form>
        </div>
      )}
      {tab === "team" && (
        <div>
          <form
            onSubmit={submit(async (form) => {
              const result = await request<{ token: string }>(
                "invites",
                "POST",
                { email: value(form, "email"), role: value(form, "role") },
              );
              setToken(result.token);
              return result;
            }, "초대를 생성했습니다. 대상 사용자에게 토큰을 직접 전달하세요.")}
          >
            <h4>7일 초대</h4>
            <label>
              이메일
              <input type="email" name="email" required />
            </label>
            <label>
              역할
              <select name="role">
                <option value="editor">편집자</option>
                <option value="reviewer">검토자</option>
                <option value="operator">운영자</option>
                <option value="visitor">방문자</option>
              </select>
            </label>
            <button disabled={busy}>초대 생성</button>
          </form>
          {token && (
            <label>
              초대 토큰
              <input value={token} readOnly />
            </label>
          )}
          <form
            onSubmit={submit(
              (form) =>
                request("invites/accept", "POST", {
                  token: value(form, "token"),
                }),
              "초대를 수락했습니다.",
            )}
          >
            <label>
              초대 토큰
              <input name="token" required />
            </label>
            <button disabled={busy}>현재 계정으로 수락</button>
          </form>
          <h4>구성원</h4>
          {members.length ? (
            members.map((member) => (
              <p key={member.id}>
                {member.email} · {member.role}{" "}
                <button
                  type="button"
                  disabled={busy || member.role === "owner"}
                  onClick={() =>
                    void run(
                      () => request(`access/${member.id}`, "DELETE", {}),
                      "접근 권한을 회수했습니다.",
                    )
                  }
                >
                  권한 회수
                </button>
              </p>
            ))
          ) : (
            <p>등록된 구성원이 없습니다.</p>
          )}
          <h4>초대 이력</h4>
          {invites.map((invitation) => (
            <p key={invitation.id}>
              {invitation.email} · {invitation.role} · {invitation.status} ·{" "}
              {new Date(invitation.expiresAt).toLocaleDateString()}{" "}
              <button
                type="button"
                disabled={busy || invitation.status !== "pending"}
                onClick={() =>
                  void run(
                    () =>
                      request(`invites/${invitation.id}/revoke`, "POST", {}),
                    "초대를 취소했습니다.",
                  )
                }
              >
                초대 취소
              </button>
            </p>
          ))}
        </div>
      )}
      {tab === "reviews" && (
        <div>
          <form
            onSubmit={submit(
              (form) =>
                request("reviews", "POST", {
                  revision: Number(value(form, "revision")),
                }),
              "검토를 요청했습니다.",
            )}
          >
            <h4>원본 검토 요청</h4>
            <label>
              저장된 revision
              <input type="number" name="revision" min={0} required />
            </label>
            <button disabled={busy}>검토 요청</button>
          </form>
          <p>요청자와 다른 계정의 검토자가 결정합니다.</p>
          {reviews.length ? (
            reviews.map((review) => (
              <article key={review.id}>
                <h4>
                  revision {review.revision} · {review.status}
                </h4>
                {review.comments.map((comment) => (
                  <p key={comment.id}>{comment.body}</p>
                ))}
                <form
                  onSubmit={submit(
                    (form) =>
                      request(`reviews/${review.id}/comments`, "POST", {
                        body: value(form, "body"),
                      }),
                    "검토 의견을 남겼습니다.",
                  )}
                >
                  <label>
                    의견
                    <textarea name="body" maxLength={2000} required />
                  </label>
                  <button disabled={busy}>의견 저장</button>
                </form>
                {review.status === "pending" && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            request(`reviews/${review.id}/decision`, "POST", {
                              status: "approved",
                            }),
                          "승인했습니다.",
                        )
                      }
                    >
                      승인
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            request(`reviews/${review.id}/decision`, "POST", {
                              status: "changes_requested",
                            }),
                          "수정을 요청했습니다.",
                        )
                      }
                    >
                      수정 요청
                    </button>
                  </>
                )}
              </article>
            ))
          ) : (
            <p>검토 요청이 없습니다.</p>
          )}
        </div>
      )}
      {tab === "connections" && (
        <div>
          <form
            onSubmit={submit(
              (form) =>
                request("connections", "PUT", {
                  name: value(form, "name"),
                  kind: value(form, "kind"),
                  endpoint: value(form, "endpoint"),
                  allowedHost: value(form, "allowedHost"),
                  secretRef: value(form, "secretRef"),
                  webhookSecretRef: value(form, "webhookSecretRef"),
                  mapping: JSON.parse(
                    value(form, "mapping") || "{}",
                  ) as unknown,
                }),
              "연결 설정을 저장했습니다. 연결 테스트를 실행하세요.",
            )}
          >
            <h4>외부 연결</h4>
            <p>
              서버의 PLATFORM_ALLOWED_HOSTS에 호스트를 등록하세요. 비밀값은 서버
              환경 변수로만 설정합니다.
            </p>
            <label>
              이름
              <input name="name" required />
            </label>
            <label>
              용도
              <select name="kind">
                <option value="mail">메일</option>
                <option value="crm">CRM</option>
                <option value="data">외부 데이터</option>
                <option value="payment">결제</option>
              </select>
            </label>
            <label>
              HTTPS 주소
              <input type="url" name="endpoint" required />
            </label>
            <label>
              허용 호스트
              <input
                name="allowedHost"
                placeholder="api.example.com"
                required
              />
            </label>
            <label>
              API 비밀 환경 변수 이름
              <input name="secretRef" placeholder="PROVIDER_API_KEY" />
            </label>
            <label>
              결제 웹훅 비밀 환경 변수 이름
              <input
                name="webhookSecretRef"
                placeholder="PROVIDER_WEBHOOK_SECRET"
              />
            </label>
            <label>
              데이터 필드 매핑
              <textarea
                name="mapping"
                defaultValue="{}"
                aria-describedby="mapping-help"
              />
            </label>
            <p id="mapping-help">
              예: {`{"name":"customer.name"}`}. 실제 비밀값을 입력하지 마세요.
            </p>
            <button disabled={busy}>연결 저장</button>
          </form>
          {connections.length ? (
            connections.map((connection) => (
              <article key={connection.id}>
                <h4>
                  {connection.name} · {connection.kind}
                </h4>
                <p>
                  {connection.configured
                    ? "환경 변수 준비"
                    : "환경 변수 미설정"}{" "}
                  · {connection.paused ? "중지" : connection.lastStatus}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        request(
                          `connections/${connection.id}/test`,
                          "POST",
                          {},
                        ),
                      "연결 응답을 확인했습니다. 실제 업무 전달은 별도 검증이 필요합니다.",
                    )
                  }
                >
                  연결 테스트
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        request(`connections/${connection.id}/pause`, "POST", {
                          paused: !connection.paused,
                        }),
                      "연결 상태를 변경했습니다.",
                    )
                  }
                >
                  {connection.paused ? "다시 연결" : "일시 중지"}
                </button>
                {connection.kind === "data" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () =>
                          setDataPreview(
                            mappedData(
                              await request<unknown>(
                                `connections/${connection.id}/data`,
                              ),
                            ),
                          ),
                        "데이터를 조회했습니다.",
                      )
                    }
                  >
                    데이터 조회
                  </button>
                )}
              </article>
            ))
          ) : (
            <p>설정한 연결이 없습니다.</p>
          )}
          {dataPreview && (
            <article>
              <h4>매핑된 외부 데이터</h4>
              <p>
                {dataPreview.rows.length}행 ·{" "}
                {dataPreview.cached ? "캐시" : "최신 API 응답"} ·{" "}
                {new Date(dataPreview.fetchedAt).toLocaleString()}
              </p>
              {dataPreview.rows.length &&
              Object.keys(dataPreview.rows[0]!).length ? (
                <div className="table-scroll">
                  <table>
                    <caption>매핑 결과 미리보기 · 첫 20행</caption>
                    <thead>
                      <tr>
                        {Object.keys(dataPreview.rows[0]!).map((key) => (
                          <th key={key} scope="col">
                            {key}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataPreview.rows.slice(0, 20).map((row, index) => (
                        <tr key={index}>
                          {Object.keys(dataPreview.rows[0]!).map((key) => (
                            <td key={key}>
                              {row[key] === null ? "" : String(row[key] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>가져올 행이나 매핑된 필드가 없습니다.</p>
              )}
              {onImportData && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    !dataPreview.rows.length ||
                    !Object.keys(dataPreview.rows[0]!).length
                  }
                  onClick={() =>
                    onImportData(dataPreview.rows.map((row) => ({ ...row })))
                  }
                >
                  표 초기 데이터로 적용 검토
                </button>
              )}
              <p>
                열 매핑과 추가·교체 범위를 검토한 후 적용합니다. 편집 표를 자동
                덮어쓰지 않습니다.
              </p>
            </article>
          )}
          <h4>발송 대기함</h4>
          <p>
            sent는 공급자 API의 수락 응답입니다. 최종 수신·업무 처리 결과와
            구분합니다.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => request("outbox/process", "POST", {}),
                "발송 대기함을 처리했습니다.",
              )
            }
          >
            대기 발송 처리
          </button>
          {outbox.length ? (
            outbox.map((event) => (
              <p key={event.id}>
                {event.eventKey} · {event.status} · {event.attempts}회{" "}
                {event.errorCode}
                <button
                  type="button"
                  disabled={busy || event.status !== "failed"}
                  onClick={() =>
                    void run(
                      () => request(`outbox/${event.id}/retry`, "POST", {}),
                      "발송 재시도를 예약했습니다.",
                    )
                  }
                >
                  재시도
                </button>
              </p>
            ))
          ) : (
            <p>발송 이벤트가 없습니다.</p>
          )}
        </div>
      )}
      {tab === "commerce" && (
        <div>
          <form
            onSubmit={submit(
              (form) =>
                request("catalog", "PUT", {
                  name: value(form, "name"),
                  priceMinor: Number(value(form, "price")),
                  currency: value(form, "currency"),
                  inventory: Number(value(form, "inventory")),
                  active: true,
                }),
              "상품을 저장했습니다.",
            )}
          >
            <h4>상품 등록</h4>
            <label>
              상품명
              <input name="name" required />
            </label>
            <label>
              최소 통화 단위 가격
              <input type="number" name="price" min={0} step={1} required />
            </label>
            <label>
              통화
              <input
                name="currency"
                defaultValue="KRW"
                maxLength={3}
                required
              />
            </label>
            <label>
              재고
              <input name="inventory" type="number" min={0} step={1} required />
            </label>
            <p>KRW는 원, USD는 센트처럼 최소 통화 단위의 정수를 사용합니다.</p>
            <button disabled={busy}>상품 저장</button>
          </form>
          {products.length ? (
            products.map((product) => (
              <p key={product.id}>
                {product.name} · {product.priceMinor} {product.currency} · 재고{" "}
                {product.inventory}{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        request("catalog", "PUT", {
                          ...product,
                          expectedUpdatedAt: product.updatedAt,
                          active: !product.active,
                        }),
                      "상품 판매 상태를 변경했습니다.",
                    )
                  }
                >
                  {product.active ? "판매 중지" : "판매 시작"}
                </button>
              </p>
            ))
          ) : (
            <p>등록한 상품이 없습니다.</p>
          )}
          <h4>주문</h4>
          {orders.length ? (
            orders.map((order) => (
              <article key={order.id}>
                <p>
                  {order.id} · {order.amountMinor} {order.currency} ·{" "}
                  {order.status} · 환불 {order.refundedMinor}
                </p>
                {order.status === "pending" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => request(`orders/${order.id}/cancel`, "POST", {}),
                        "주문을 취소하고 재고를 복원했습니다.",
                      )
                    }
                  >
                    주문 취소
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || order.status === "pending"}
                  onClick={() =>
                    void run(
                      () => request(`orders/${order.id}/reconcile`, "POST", {}),
                      "공급자 주문 상태를 대사했습니다.",
                    )
                  }
                >
                  공급자 상태 대사
                </button>
                {["paid", "partially_refunded"].includes(order.status) && (
                  <form
                    onSubmit={submit(
                      (form) =>
                        request(`orders/${order.id}/refund`, "POST", {
                          amountMinor: Number(value(form, "amount")),
                          idempotencyKey: crypto.randomUUID(),
                        }),
                      "환불을 요청했습니다. 웹훅·대사로 완료를 확인하세요.",
                    )}
                  >
                    <label>
                      환불 금액
                      <input
                        name="amount"
                        type="number"
                        min={1}
                        max={order.amountMinor - order.refundedMinor}
                        step={1}
                        required
                      />
                    </label>
                    <button disabled={busy}>환불 요청</button>
                  </form>
                )}
              </article>
            ))
          ) : (
            <p>
              주문이 없습니다. 실제 사이트에서 로그인한 고객이 주문할 수
              있습니다.
            </p>
          )}
          <p>
            결제 완료는 서명된 공급자 웹훅 또는 서버 상태 대사로만 기록합니다.
          </p>
        </div>
      )}
      {tab === "booking" && (
        <div>
          <form
            onSubmit={submit(
              (form) =>
                request("booking/resources", "PUT", {
                  name: value(form, "name"),
                  capacity: Number(value(form, "capacity")),
                  active: true,
                }),
              "예약 자원을 저장했습니다.",
            )}
          >
            <h4>예약 자원</h4>
            <label>
              자원명
              <input name="name" required />
            </label>
            <label>
              최대 정원
              <input type="number" name="capacity" min={1} step={1} required />
            </label>
            <button disabled={busy}>자원 저장</button>
          </form>
          <form
            onSubmit={submit(
              (form) =>
                request("booking/slots", "POST", {
                  resourceId: value(form, "resourceId"),
                  startsAt: new Date(value(form, "start")).toISOString(),
                  endsAt: new Date(value(form, "end")).toISOString(),
                  capacity: Number(value(form, "capacity")),
                }),
              "예약 시간을 등록했습니다.",
            )}
          >
            <h4>시간 등록</h4>
            <label>
              자원
              <select name="resourceId" required>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name} · {resource.capacity}명
                  </option>
                ))}
              </select>
            </label>
            <label>
              시작 · 현재 시간대
              <input type="datetime-local" name="start" required />
            </label>
            <label>
              종료 · 현재 시간대
              <input type="datetime-local" name="end" required />
            </label>
            <label>
              시간별 정원
              <input name="capacity" type="number" min={1} step={1} required />
            </label>
            <button disabled={busy || !resources.length}>예약 시간 등록</button>
          </form>
          {slots.map((slot) => (
            <p key={slot.id}>
              {slot.name} · {new Date(slot.startsAt).toLocaleString()} · 남은
              정원 {slot.available}
            </p>
          ))}
          <h4>예약 이력</h4>
          {bookings.length ? (
            bookings.map((booking) => (
              <p key={booking.id}>
                {booking.name} · {new Date(booking.startsAt).toLocaleString()} ·{" "}
                {booking.quantity}명 · {booking.status}{" "}
                <button
                  type="button"
                  disabled={busy || booking.status === "cancelled"}
                  onClick={() =>
                    void run(
                      () =>
                        request(`bookings/${booking.id}/cancel`, "POST", {}),
                      "예약을 취소했습니다.",
                    )
                  }
                >
                  예약 취소
                </button>
              </p>
            ))
          ) : (
            <p>예약이 없습니다.</p>
          )}
        </div>
      )}
      {tab === "billing" && (
        <div>
          <p>현재 로컬 정책 플랜: {billing?.plan ?? "local"}</p>
          <form
            key={billing?.plan ?? "local"}
            onSubmit={submit((form) => {
              const limits: Record<string, number> = {};
              for (const metric of [
                "orders",
                "bookings",
                "submissions",
                "generations",
                "storageBytes",
              ])
                if (value(form, metric))
                  limits[metric] = Number(value(form, metric));
              return request("billing", "PUT", {
                plan: value(form, "plan"),
                limits,
              });
            }, "월별 로컬 사용량 한도를 저장했습니다.")}
          >
            <label>
              플랜 이름
              <input
                name="plan"
                defaultValue={billing?.plan ?? "local"}
                required
              />
            </label>
            {[
              ["orders", "주문"],
              ["bookings", "예약"],
              ["submissions", "문의"],
              ["generations", "생성"],
              ["storageBytes", "저장 바이트"],
            ].map(([key, label]) => (
              <label key={key}>
                {label} 한도
                <input
                  type="number"
                  name={key}
                  min={0}
                  step={1}
                  defaultValue={billing?.limits[key!]}
                  placeholder="비워두면 제한 없음"
                />
              </label>
            ))}
            <button disabled={busy}>한도 저장</button>
          </form>
          <h4>이번 달 사용량</h4>
          {usage.length ? (
            usage.map((entry) => (
              <p key={entry.metric}>
                {entry.metric}: {entry.value}
              </p>
            ))
          ) : (
            <p>기록된 사용량이 없습니다.</p>
          )}
          <p>
            이 설정은 로컬 사용량 정책입니다. 외부 유료 구독 계약을 의미하지
            않습니다.
          </p>
          <PlatformBillingPanel projectId={projectId} onMessage={onMessage} />
        </div>
      )}
    </section>
  );
}
