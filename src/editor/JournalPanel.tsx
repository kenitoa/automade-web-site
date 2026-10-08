import { useEffect, useState } from "react";
import {
  listCommands,
  storageHealth,
  compactAcknowledgedCommands,
  type EditorCommand,
} from "../infrastructure/projectJournal";
import type { StudioState } from "./useStudio";
export default function JournalPanel({ studio: s }: { studio: StudioState }) {
  const [items, setItems] = useState<EditorCommand[]>([]),
    [health, setHealth] = useState<{
      usage: number;
      quota: number;
      persistent: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    try {
      const [commands, storage] = await Promise.all([
        listCommands(s.project.id),
        storageHealth(),
      ]);
      setItems(commands);
      setHealth(storage);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "변경 보관 상태를 확인하세요.");
    }
  }
  useEffect(() => {
    void refresh();
    const update = () => void refresh();
    window.addEventListener("automade:journal", update);
    return () => window.removeEventListener("automade:journal", update);
  }, [s.project.id]);
  const pending = items.filter((item) =>
    ["pending", "blocked"].includes(item.status),
  );
  async function check() {
    setBusy(true);
    setError("");
    try {
      // Replaying the original command obtains the canonical ACK before the
      // journal clears its payload and advances the local synchronization base.
      await s.retrySave();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "서버 확인을 재조회하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="journal-panel">
      <summary>
        이 기기 변경·서버 확인{" "}
        {pending.length ? `· 대기 ${pending.length}` : ""}
      </summary>
      <p>
        문서 변경만 보관합니다. 권한·결제·삭제 운영 작업은 오프라인에서 실행하지
        않습니다. 서버 확인을 받지 못한 변경은 정리하지 않습니다.
      </p>
      {health && (
        <p>
          보관 공간 {(health.usage / 1024 / 1024).toFixed(1)}MB /{" "}
          {health.quota
            ? (health.quota / 1024 / 1024).toFixed(0) + "MB"
            : "브라우저 미제공"}{" "}
          ·{" "}
          {health.persistent
            ? "지속 보관 허용"
            : "브라우저가 공간을 회수할 수 있음"}
        </p>
      )}
      {health && health.quota > 0 && health.usage / health.quota > 0.85 && (
        <p role="alert" className="bad">
          저장 공간이 부족합니다. 원본을 파일로 보존하고 확인된 오래된 변경만
          정리하세요.
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          disabled={busy || !s.online || !s.editable}
          onClick={() => void check()}
        >
          서버 확인·미반영 변경 재전송
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void s.exportOriginal()}
        >
          현재 원본 파일 보존
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void compactAcknowledgedCommands()
              .then(() => refresh())
              .catch((e) => setError(String(e)))
          }
        >
          확인된 이전 명령만 정리
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.storage?.persist().then(() => refresh())
          }
        >
          지속 보관 요청
        </button>
      </div>
      <ul>
        {items
          .slice(-30)
          .reverse()
          .map((item) => (
            <li key={item.commandId}>
              <strong>
                {
                  {
                    pending: "서버 확인 대기",
                    blocked: "권한·충돌 검토 필요",
                    acknowledged: "서버 확인됨",
                    superseded: "확인된 최신 변경에 포함",
                  }[item.status]
                }
              </strong>{" "}
              · 기준 v{item.baseRevision}
              {item.revision !== undefined && ` → v${item.revision}`} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
              {item.reason && <p>{item.reason}</p>}
            </li>
          ))}
      </ul>
      {!items.length && <p>이 프로젝트의 보관된 변경 명령이 없습니다.</p>}
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
    </details>
  );
}
