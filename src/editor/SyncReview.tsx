import { useState } from "react";
import type { Project } from "../domain/types";
import {
  mergeProjects,
  type MergeChoices,
} from "../infrastructure/projectMerge";
import EditorDialog from "./EditorDialog";
import ChangeReview from "./ChangeReview";
export interface SyncConflict {
  base: Project;
  local: Project;
  remote: Project;
}
export default function SyncReview({
  conflict,
  onApply,
  onClose,
}: {
  conflict: SyncConflict;
  onApply: (project: Project) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<MergeChoices>({}),
    result = mergeProjects(
      conflict.base,
      conflict.local,
      conflict.remote,
      choices,
    ),
    remaining = result.conflicts.filter((item) => !choices[item.path]).length;
  const display = (value: unknown) =>
    value === undefined
      ? "삭제됨"
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  const title=(path:string)=>{const parts=path.split("/").filter(Boolean).map(decodeURIComponent),id=parts.find(part=>part.startsWith("@"))?.slice(1);const block=[...conflict.local.blocks,...conflict.remote.blocks,...conflict.base.blocks].find(b=>b.id===id);const labels:Record<string,string>={title:"제목",body:"본문",schema:"콘텐츠 모델",workflow:"검토·승인",design:"디자인",layout:"배치","$order":"항목 순서"};return `${block?.props.title||block?.name||"문서"} · ${labels[parts.at(-1)||""]||parts.at(-1)}`;};
  return (
    <EditorDialog title="온라인·오프라인 변경 비교" onClose={onClose}>
      <p>
        마지막 동기화 v{conflict.base.revision}, 이 기기 v
        {conflict.local.revision}, 서버 v{conflict.remote.revision}를
        비교합니다. 서로 다른 필드 변경은 병합하고 겹친 변경은 직접 선택합니다.
      </p>
      {result.conflicts.map((item) => (
        <fieldset key={item.path}>
          <legend>{title(item.path)}</legend>
          <p>{({field:"같은 필드의 변경",delete:"삭제와 수정의 충돌",order:"항목 순서의 충돌",schema:"콘텐츠 모델 변경",approval:"검토·승인 상태 영향"})[item.kind||"field"]} · 각 변경의 결과를 비교하세요.</p>
          <details><summary>변경 경로</summary><code>{item.path}</code></details>
          <div className="merge-values">
            <div>
              <strong>기준</strong>
              <pre>{display(item.base)}</pre>
            </div>
            <div>
              <strong>이 기기</strong>
              <pre>{display(item.local)}</pre>
            </div>
            <div>
              <strong>서버</strong>
              <pre>{display(item.remote)}</pre>
            </div>
          </div>
          <label>
            이 필드 반영
            <select
              value={choices[item.path] || ""}
              onChange={(e) =>
                setChoices({
                  ...choices,
                  [item.path]: e.target.value as "local" | "remote",
                })
              }
            >
              <option value="">변경 선택</option>
              <option value="local">이 기기 변경</option>
              <option value="remote">서버 변경</option>
            </select>
          </label>
        </fieldset>
      ))}
      {result.error && (
        <p role="alert" className="bad">
          {result.error}
        </p>
      )}
      {result.project && (
        <ChangeReview before={conflict.remote} after={result.project} />
      )}
      <p>
        {remaining
          ? `선택하지 않은 충돌 ${remaining}개`
          : "모든 충돌을 확인했습니다."}
      </p>
      <button
        type="button"
        className="primary"
        disabled={!result.project || Boolean(remaining)}
        onClick={() => {
          if (result.project) onApply(result.project);
        }}
      >
        검토한 병합 적용·동기화
      </button>
      <p className="hint">
        원본과 이전 버전은 보존합니다. 서버가 다시 변경되면 새 충돌을 비교해야
        합니다.
      </p>
    </EditorDialog>
  );
}
