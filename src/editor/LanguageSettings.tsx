import { useState } from "react";
import { normalizeLanguage, languageLabel } from "../domain/languages";
import { parseProject } from "../domain/validation";
import type { StudioState } from "./useStudio";
export default function LanguageSettings({
  studio: s,
}: {
  studio: StudioState;
}) {
  const [code, setCode] = useState(""),
    [error, setError] = useState("");
  const languages = [
    ...new Set([
      s.project.settings.language,
      ...(s.project.settings.languages || []),
    ]),
  ];
  function add() {
    try {
      const language = normalizeLanguage(code);
      if (languages.includes(language))
        throw new Error("이미 지원하는 언어입니다.");
      if (languages.length >= 30)
        throw new Error("지원 언어는 최대 30개입니다.");
      s.apply((p) => {
        p.settings.languages = [...languages, language];
      });
      setCode("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "언어 코드를 확인하세요.");
    }
  }
  function fallback(language: string, target: string) {
    try {
      const next = structuredClone(s.project);
      next.settings.languageFallbacks ??= {};
      if (target) next.settings.languageFallbacks[language] = target;
      else delete next.settings.languageFallbacks[language];
      parseProject(next);
      s.apply((p) => {
        p.settings.languageFallbacks = next.settings.languageFallbacks;
      });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "대체 언어를 확인하세요.");
    }
  }
  return (
    <details>
      <summary>언어·지역·원문 대체</summary>
      <p className="hint">
        BCP 47 언어·지역 코드를 사용합니다. 빈 번역은 지정한 대체 언어를 거쳐
        기본 원문으로 표시합니다. 원문 변경 뒤 번역 검토 여부를 확인하세요.
      </p>
      {languages.map((language) => (
        <fieldset key={language}>
          <legend>
            {languageLabel(language)} ({language})
          </legend>
          <label>
            번역 누락 시 대체
            <select
              value={s.project.settings.languageFallbacks?.[language] || ""}
              onChange={(e) => fallback(language, e.target.value)}
            >
              <option value="">기본 원문</option>
              {languages
                .filter((value) => value !== language)
                .map((value) => (
                  <option key={value} value={value}>
                    {languageLabel(value)}
                  </option>
                ))}
            </select>
          </label>
          {language !== s.project.settings.language && (
            <button
              type="button"
              onClick={() =>
                s.apply((p) => {
                  p.settings.languages = languages.filter(
                    (value) => value !== language,
                  );
                  if (p.settings.languageFallbacks) {
                    delete p.settings.languageFallbacks[language];
                    for (const [source, target] of Object.entries(
                      p.settings.languageFallbacks,
                    ))
                      if (target === language)
                        delete p.settings.languageFallbacks[source];
                  }
                })
              }
            >
              지원 언어에서 제외 (번역 자료 보존)
            </button>
          )}
        </fieldset>
      ))}
      <label>
        추가 언어·지역 코드
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ja, fr, en-GB"
          maxLength={80}
        />
      </label>
      <button type="button" disabled={!code.trim()} onClick={add}>
        언어 검증·추가
      </button>
      {error && (
        <p role="alert" className="bad">
          {error}
        </p>
      )}
    </details>
  );
}
