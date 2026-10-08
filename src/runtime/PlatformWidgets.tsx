import { useCallback, useEffect, useRef, useState } from "react";
import { uid } from "../domain/catalog";
import { record } from "../domain/validation";
import type { BookingWaitlistEntry } from "../domain/expansion";
import {
  parseWaitlistEntries,
  visibleWaitlistState,
  waitlistStatusLabel,
} from "../domain/waitlist";

interface Session {
  account: { id: string; email: string; displayName: string } | null;
  csrf: string;
  localOwner: boolean;
}
interface Capabilities {
  canManage: boolean;
  commerce: boolean;
  booking: boolean;
  paymentConfigured: boolean;
  paymentConnectionId?: string;
}
interface Product {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  inventory: number;
  active: boolean;
}
interface Slot {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  available: number;
  capacity: number;
}
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const money = (minor: number, currency: string): string => {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "KRW",
  });
  return formatter.format(
    minor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2),
  );
};

/** An authenticated connector to the generated server; preview never creates accounts or transactions. */
export default function PlatformWidgets({
  projectId,
  apiBase,
  mode,
}: {
  projectId: string;
  apiBase: string;
  mode: "preview" | "site";
}) {
  const [session, setSession] = useState<Session | null>(null),
    [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [products, setProducts] = useState<Product[]>([]),
    [slots, setSlots] = useState<Slot[]>([]),
    [orders, setOrders] = useState<Record<string, unknown>[]>([]),
    [bookings, setBookings] = useState<Record<string, unknown>[]>([]);
  const [waitlist, setWaitlist] = useState<BookingWaitlistEntry[]>([]),
    [waitlistLoading, setWaitlistLoading] = useState(false),
    [waitlistError, setWaitlistError] = useState(""),
    [clock, setClock] = useState(Date.now);
  const [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [accountMode, setAccountMode] = useState<"login" | "register" | "reset">(
      "login",
    );
  const csrf = useRef(""),
    orderKey = useRef(uid()),
    bookingKey = useRef(uid());
  const waitlistEpoch = useRef(0);
  const request = useCallback(
    async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      const response = await fetch(`${apiBase}api/platform/${path}`, {
        method,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(method !== "GET" ? { "X-Platform-CSRF": csrf.current } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      const json = record(await response.json());
      if (!response.ok || json.error)
        throw new Error(
          string(record(json.error).message) ||
            "요청을 처리하지 못했습니다. 다시 시도하세요.",
        );
      return json.data;
    },
    [apiBase],
  );
  const loadWaitlist = useCallback(async () => {
    const epoch = ++waitlistEpoch.current;
    setWaitlistLoading(true);
    try {
      const rows = parseWaitlistEntries(await request("bookings/waitlist"));
      if (epoch !== waitlistEpoch.current) return;
      setWaitlist(rows);
      setWaitlistError("");
      setClock(Date.now());
    } catch (error) {
      if (epoch === waitlistEpoch.current)
        setWaitlistError(
          error instanceof Error ? error.message : "예약 대기 목록 조회 실패",
        );
    } finally {
      if (epoch === waitlistEpoch.current) setWaitlistLoading(false);
    }
  }, [request]);
  const refresh = useCallback(async () => {
    const value = record(await request("session")),
      account = record(value.account);
    csrf.current = string(value.csrf);
    setSession({
      account: string(account.id)
        ? {
            id: string(account.id),
            email: string(account.email),
            displayName: string(account.displayName),
          }
        : null,
      csrf: csrf.current,
      localOwner: value.localOwner === true,
    });
    const caps = record(
      await request(`capabilities?projectId=${encodeURIComponent(projectId)}`),
    );
    setCapabilities({
      canManage: caps.canManage === true,
      commerce: caps.commerce === true,
      booking: caps.booking === true,
      paymentConfigured: caps.paymentConfigured === true,
      paymentConnectionId: string(caps.paymentConnectionId),
    });
    window.dispatchEvent(
      new CustomEvent("site-capabilities", {
        detail: {
          canManage: caps.canManage === true,
          csrf: csrf.current,
          account: value.account,
        },
      }),
    );
    if (caps.commerce === true)
      setProducts(
        array(
          await request(`catalog?projectId=${encodeURIComponent(projectId)}`),
        )
          .map((value) => {
            const p = record(value);
            return {
              id: string(p.id),
              name: string(p.name),
              priceMinor: number(p.priceMinor ?? p.price_minor),
              currency: string(p.currency),
              inventory: number(p.inventory),
              active: p.active === true || p.active === 1,
            };
          })
          .filter((p) => p.active),
      );
    if (caps.booking === true)
      setSlots(
        array(
          await request(
            `booking/slots?projectId=${encodeURIComponent(projectId)}`,
          ),
        ).map((value) => {
          const s = record(value);
          return {
            id: string(s.id),
            name: string(s.name),
            startsAt: string(s.startsAt ?? s.starts_at),
            endsAt: string(s.endsAt ?? s.ends_at),
            available: number(s.available),
            capacity: number(s.capacity),
          };
        }),
      );
    if (account.id) {
      if (caps.commerce === true)
        setOrders(
          array(
            await request(`orders?projectId=${encodeURIComponent(projectId)}`),
          ).map(record),
        );
      if (caps.booking === true)
        setBookings(
          array(
            await request(
              `bookings?projectId=${encodeURIComponent(projectId)}`,
            ),
          ).map(record),
        );
    } else {
      setOrders([]);
      setBookings([]);
      ++waitlistEpoch.current;
      setWaitlist([]);
      setWaitlistError("");
      setWaitlistLoading(false);
    }
  }, [request, projectId]);
  useEffect(() => {
    if (mode !== "site") return;
    let alive = true;
    refresh().catch((error) => {
      if (alive)
        setError(
          error instanceof Error ? error.message : "계정 서비스 조회 실패",
        );
    });
    return () => {
      alive = false;
    };
  }, [mode, refresh]);
  useEffect(() => {
    if (mode !== "site" || !session?.account || !capabilities?.booking) return;
    void loadWaitlist();
    const poll = () => {
      if (document.visibilityState === "visible") void loadWaitlist();
    };
    const timer = window.setInterval(poll, 30000);
    window.addEventListener("focus", poll);
    return () => {
      ++waitlistEpoch.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [mode, session?.account?.id, capabilities?.booking, loadWaitlist]);
  const hasOffer = waitlist.some(
    (entry) =>
      entry.status === "offered" && (entry.offerExpiresAt ?? 0) > clock,
  );
  useEffect(() => {
    if (!hasOffer) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasOffer]);
  const run = async (action: () => Promise<void>) => {
    if (busy || mode !== "site") return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "처리 실패");
    } finally {
      setBusy(false);
    }
  };
  if (mode === "preview") return null;
  return (
    <section className="site-platform" aria-label="계정과 주문 및 예약">
      <details>
        <summary>
          {session?.account
            ? `${session.account.displayName || session.account.email} · 내 계정`
            : "회원 로그인 및 가입"}
        </summary>
        {!session ? (
          <p role="status">계정 서비스를 확인하는 중입니다.</p>
        ) : session.account ? (
          <div className="site-actions">
            <p>{session.account.displayName || session.account.email}</p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request("logout", "POST", {});
                  await refresh();
                  window.dispatchEvent(
                    new CustomEvent("site-session-changed", {
                      detail: { authenticated: false },
                    }),
                  );
                  setStatus("로그아웃했습니다.");
                })
              }
            >
              로그아웃
            </button>
          </div>
        ) : (
          <>
            <div className="site-actions">
              {(["login", "register", "reset"] as const).map((kind) => (
                <button
                  type="button"
                  className={accountMode === kind ? "active" : "secondary"}
                  key={kind}
                  onClick={() => setAccountMode(kind)}
                >
                  {kind === "login"
                    ? "로그인"
                    : kind === "register"
                      ? "회원가입"
                      : "비밀번호 재설정"}
                </button>
              ))}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget,
                  fd = new FormData(form);
                void run(async () => {
                  if (accountMode === "reset") {
                    const result = record(
                      await request("password-reset/request", "POST", {
                        email: fd.get("email"),
                        projectId,
                      }),
                    );
                    setStatus(
                      (string(result.message) ||
                        "해당 계정이 있다면 재설정 안내를 보냈습니다.") +
                        (session.localOwner && string(result.localRecoveryToken)
                          ? ` 로컬 복구 코드: ${string(result.localRecoveryToken)}`
                          : ""),
                    );
                    return;
                  }
                  await request(
                    accountMode === "register" ? "accounts" : "login",
                    "POST",
                    {
                      email: fd.get("email"),
                      password: fd.get("password"),
                      ...(accountMode === "register"
                        ? { displayName: fd.get("displayName") }
                        : {}),
                    },
                  );
                  if (accountMode === "register")
                    await request("login", "POST", {
                      email: fd.get("email"),
                      password: fd.get("password"),
                    });
                  form.reset();
                  await refresh();
                  window.dispatchEvent(
                    new CustomEvent("site-session-changed", {
                      detail: { authenticated: true },
                    }),
                  );
                  setStatus(
                    accountMode === "register"
                      ? "가입했습니다."
                      : "로그인했습니다.",
                  );
                });
              }}
            >
              <label className="site-field">
                이메일
                <input
                  type="email"
                  name="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                  disabled={busy}
                />
              </label>
              {accountMode === "register" ? (
                <label className="site-field">
                  표시 이름
                  <input
                    name="displayName"
                    required
                    maxLength={100}
                    autoComplete="name"
                    disabled={busy}
                  />
                </label>
              ) : null}
              {accountMode !== "reset" ? (
                <label className="site-field">
                  비밀번호
                  <input
                    type="password"
                    name="password"
                    required
                    minLength={accountMode === "register" ? 12 : undefined}
                    maxLength={128}
                    autoComplete={
                      accountMode === "register"
                        ? "new-password"
                        : "current-password"
                    }
                    disabled={busy}
                  />
                </label>
              ) : null}
              <button type="submit" disabled={busy}>
                {busy
                  ? "처리 중…"
                  : accountMode === "login"
                    ? "로그인"
                    : accountMode === "register"
                      ? "가입"
                      : "재설정 안내 요청"}
              </button>
            </form>
            {accountMode === "reset" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const fd = new FormData(event.currentTarget);
                  void run(async () => {
                    await request("password-reset/confirm", "POST", {
                      token: fd.get("token"),
                      password: fd.get("password"),
                    });
                    setStatus("비밀번호를 변경했습니다. 다시 로그인하세요.");
                    setAccountMode("login");
                  });
                }}
              >
                <h3>재설정 완료</h3>
                <label className="site-field">
                  받은 재설정 코드
                  <input
                    name="token"
                    required
                    autoComplete="off"
                    disabled={busy}
                  />
                </label>
                <label className="site-field">
                  새 비밀번호
                  <input
                    type="password"
                    name="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </label>
                <button disabled={busy}>비밀번호 변경</button>
              </form>
            ) : null}
          </>
        )}
      </details>
      {capabilities?.commerce ? (
        <details>
          <summary>상품과 내 주문</summary>
          {!products.length ? (
            <p className="site-empty">판매 중인 상품이 없습니다.</p>
          ) : (
            <div className="site-grid">
              {products.map((product) => (
                <article className="site-card" key={product.id}>
                  <h3>{product.name}</h3>
                  <p>{money(product.priceMinor, product.currency)}</p>
                  <p>구매 가능: {product.inventory}</p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const fd = new FormData(event.currentTarget);
                      void run(async () => {
                        await request("orders", "POST", {
                          projectId,
                          items: [
                            {
                              productId: product.id,
                              quantity: Number(fd.get("quantity")),
                            },
                          ],
                          idempotencyKey: orderKey.current,
                        });
                        orderKey.current = uid();
                        await refresh();
                        setStatus(
                          "주문을 만들었습니다. 내 주문에서 결제를 진행하세요.",
                        );
                      });
                    }}
                  >
                    <label className="site-field">
                      수량
                      <input
                        type="number"
                        name="quantity"
                        required
                        min={1}
                        max={product.inventory}
                        step={1}
                        defaultValue={1}
                        disabled={busy}
                      />
                    </label>
                    <button
                      disabled={
                        busy || !session?.account || product.inventory < 1
                      }
                    >
                      주문 만들기
                    </button>
                  </form>
                </article>
              ))}
            </div>
          )}
          {!session?.account ? <p>주문하려면 로그인하세요.</p> : null}
          <h3>내 주문</h3>
          {!orders.length ? (
            <p className="site-empty">주문이 없습니다.</p>
          ) : (
            orders.map((order) => (
              <article key={string(order.id)} className="site-card">
                <p>
                  주문 {string(order.id).slice(0, 8)} · {string(order.status)}
                </p>
                <p>
                  {money(
                    number(order.amountMinor ?? order.amount_minor),
                    string(order.currency),
                  )}
                </p>
                <div className="site-actions">
                  {[
                    "pending",
                    "created",
                    "awaiting_payment",
                    "checkout_pending",
                  ].includes(string(order.status)) &&
                  capabilities.paymentConfigured ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = record(
                            await request(
                              `orders/${encodeURIComponent(string(order.id))}/checkout`,
                              "POST",
                              {
                                connectionId:
                                  capabilities.paymentConnectionId || "",
                              },
                            ),
                          );
                          const url = new URL(string(result.checkoutUrl));
                          if (
                            url.protocol !== "https:" ||
                            url.username ||
                            url.password
                          )
                            throw new Error(
                              "결제 서비스의 이동 주소를 확인하지 못했습니다.",
                            );
                          location.href = url.href;
                        })
                      }
                    >
                      결제 서비스로 이동
                    </button>
                  ) : null}
                  {[
                    "pending",
                    "created",
                    "awaiting_payment",
                    "checkout_pending",
                  ].includes(string(order.status)) ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await request(
                            `orders/${encodeURIComponent(string(order.id))}/cancel`,
                            "POST",
                            {},
                          );
                          await refresh();
                          setStatus("주문을 취소했습니다.");
                        })
                      }
                    >
                      주문 취소
                    </button>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </details>
      ) : null}
      {capabilities?.booking ? (
        <details>
          <summary>예약과 내 일정</summary>
          {!slots.length ? (
            <p className="site-empty">예약 가능한 일정이 없습니다.</p>
          ) : (
            slots.map((slot) => (
              <article key={slot.id} className="site-card">
                <h3>{slot.name}</h3>
                <p>
                  {new Date(slot.startsAt).toLocaleString()} ~{" "}
                  {new Date(slot.endsAt).toLocaleString()}
                </p>
                <p>예약 가능: {slot.available}</p>
                {slot.available < 1 ? (
                  <p>
                    현재 매진입니다. 대기를 신청하면 예약 제안을 확인할 수
                    있습니다.
                  </p>
                ) : null}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fd = new FormData(event.currentTarget);
                    void run(async () => {
                      if (slot.available < 1) {
                        await request("bookings/waitlist", "POST", {
                          slotId: slot.id,
                          quantity: Number(fd.get("quantity")),
                        });
                        await loadWaitlist();
                        setStatus(
                          "예약 대기를 신청했습니다. 내 예약 대기에서 제안을 확인하세요.",
                        );
                        return;
                      }
                      await request("bookings", "POST", {
                        projectId,
                        slotId: slot.id,
                        quantity: Number(fd.get("quantity")),
                        idempotencyKey: bookingKey.current,
                      });
                      bookingKey.current = uid();
                      await refresh();
                      setStatus("예약을 접수했습니다.");
                    });
                  }}
                >
                  <label className="site-field">
                    인원
                    <input
                      name="quantity"
                      type="number"
                      required
                      min={1}
                      max={slot.available < 1 ? slot.capacity : slot.available}
                      defaultValue={1}
                      step={1}
                      disabled={
                        busy ||
                        (slot.available < 1 &&
                          waitlist.some((entry) => entry.slotId === slot.id))
                      }
                    />
                  </label>
                  <button
                    disabled={
                      busy ||
                      !session?.account ||
                      (slot.available < 1 &&
                        (waitlistLoading ||
                          waitlist.some((entry) => entry.slotId === slot.id)))
                    }
                  >
                    {slot.available < 1 ? "대기 신청" : "예약"}
                  </button>
                </form>
                {slot.available < 1 &&
                waitlist.some((entry) => entry.slotId === slot.id) ? (
                  <p>신청한 대기는 내 예약 대기에서 확인하세요.</p>
                ) : null}
              </article>
            ))
          )}
          {!session?.account ? <p>예약하려면 로그인하세요.</p> : null}
          <h3>내 예약</h3>
          {!bookings.length ? (
            <p className="site-empty">예약이 없습니다.</p>
          ) : (
            bookings.map((booking) => (
              <article key={string(booking.id)} className="site-card">
                <p>
                  예약 {string(booking.id).slice(0, 8)} ·{" "}
                  {string(booking.status)}
                </p>
                {string(booking.status) !== "cancelled" ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `bookings/${encodeURIComponent(string(booking.id))}/cancel`,
                          "POST",
                          {},
                        );
                        await refresh();
                        setStatus("예약을 취소했습니다.");
                      })
                    }
                  >
                    예약 취소
                  </button>
                ) : null}
              </article>
            ))
          )}
          {session?.account ? (
            <section aria-label="내 예약 대기">
              <h3>내 예약 대기</h3>
              <p>
                예약 제안은 기한 안에 수락해야 확정됩니다. 이 화면은 30초마다
                대기 현황을 확인합니다.
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy || waitlistLoading}
                onClick={() => void loadWaitlist()}
              >
                대기 현황 새로고침
              </button>
              {waitlistLoading ? (
                <p role="status">예약 대기 현황을 확인하는 중입니다.</p>
              ) : null}
              {waitlistError ? (
                <p role="alert" className="site-error">
                  {waitlistError}
                </p>
              ) : null}
              {!waitlistLoading && !waitlistError && !waitlist.length ? (
                <p className="site-empty">신청한 예약 대기가 없습니다.</p>
              ) : null}
              {waitlist.map((entry) => {
                const state = visibleWaitlistState(entry, clock),
                  slot = slots.find((slot) => slot.id === entry.slotId);
                return (
                  <article
                    key={entry.id}
                    className="site-card"
                    data-waitlist-id={entry.id}
                  >
                    <h4>
                      {slot?.name || "예약 일정"} · {entry.quantity}명
                    </h4>
                    {slot ? (
                      <p>{new Date(slot.startsAt).toLocaleString()}</p>
                    ) : null}
                    <p>{waitlistStatusLabel(state)}</p>
                    {state === "offered" && entry.offerExpiresAt !== null ? (
                      <p>
                        수락 기한:{" "}
                        <time
                          dateTime={new Date(
                            entry.offerExpiresAt,
                          ).toISOString()}
                        >
                          {new Date(entry.offerExpiresAt).toLocaleString()}
                        </time>
                      </p>
                    ) : null}
                    {entry.bookingId ? (
                      <p>확정 예약: {entry.bookingId.slice(0, 8)}</p>
                    ) : null}
                    <div className="site-actions">
                      {state === "offered" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await request(
                                `bookings/waitlist/${encodeURIComponent(entry.id)}/accept`,
                                "POST",
                                {},
                              );
                              await refresh();
                              await loadWaitlist();
                              setStatus(
                                "대기 제안을 수락하여 예약이 확정되었습니다.",
                              );
                            })
                          }
                        >
                          예약 제안 수락
                        </button>
                      ) : null}
                      {state === "waiting" || state === "offered" ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await request(
                                `bookings/waitlist/${encodeURIComponent(entry.id)}/cancel`,
                                "POST",
                                {},
                              );
                              await refresh();
                              await loadWaitlist();
                              setStatus("예약 대기를 취소했습니다.");
                            })
                          }
                        >
                          대기 취소
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </section>
          ) : null}
        </details>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {error ? (
        <p role="alert" className="site-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
