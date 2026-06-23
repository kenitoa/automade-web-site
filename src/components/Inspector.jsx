import { ALIGNMENT_OPTIONS, DENSITY_OPTIONS, TONE_OPTIONS } from "../data/blockCatalog.js";
import { getBlockNavigationLabel } from "../lib/blockRuntime.js";
import { LANGUAGE_OPTIONS } from "../lib/i18n.js";

export default function Inspector({
  project,
  selectedBlock,
  t,
  onUpdateBlock,
  onUpdateTheme,
  onUpdateSettings,
  onReset,
}) {
  const layout = selectedBlock?.layout;
  const design = selectedBlock?.design;

  return (
    <aside className="panel inspector-panel" aria-label="Inspector">
      <div className="panel-header">
        <span className="eyebrow">{t("inspectorKicker")}</span>
        <h2>{t("inspectorTitle")}</h2>
      </div>

      <fieldset>
        <legend>{t("language")}</legend>
        <label>
          {t("language")}
          <select
            value={project.settings.language}
            onChange={(event) => onUpdateSettings({ language: event.target.value })}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {project.settings.language === "custom" ? (
          <label>
            {t("customLabels")}
            <textarea
              rows="5"
              value={project.settings.customLanguageText}
              placeholder={t("customLabelsHelp")}
              onChange={(event) => onUpdateSettings({ customLanguageText: event.target.value })}
            />
          </label>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>{t("theme")}</legend>
        <label>
          {t("projectName")}
          <input
            value={project.name}
            onChange={(event) => onUpdateTheme({ projectName: event.target.value })}
            data-field="project-name"
          />
        </label>
        <label>
          {t("brandColor")}
          <input
            type="color"
            value={project.theme.brandColor}
            onChange={(event) => onUpdateTheme({ brandColor: event.target.value })}
          />
        </label>
        <label>
          {t("accentColor")}
          <input
            type="color"
            value={project.theme.accentColor}
            onChange={(event) => onUpdateTheme({ accentColor: event.target.value })}
          />
        </label>
        <label>
          {t("surfaceColor")}
          <input
            type="color"
            value={project.theme.surfaceColor}
            onChange={(event) => onUpdateTheme({ surfaceColor: event.target.value })}
          />
        </label>
        <label>
          {t("radius")}
          <input
            type="range"
            min="0"
            max="16"
            value={project.theme.radius}
            onChange={(event) => onUpdateTheme({ radius: Number(event.target.value) })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t("selectedBlock")}</legend>
        {!selectedBlock ? (
          <p className="muted">{t("selectBlockHelp")}</p>
        ) : (
          <>
            <label>
              {t("title")}
              <input
                value={selectedBlock.props.title}
                onChange={(event) => onUpdateBlock({ title: event.target.value })}
              />
            </label>
            <label>
              {t("body")}
              <textarea
                rows="4"
                value={selectedBlock.props.body}
                onChange={(event) => onUpdateBlock({ body: event.target.value })}
              />
            </label>
            <label>
              {t("primaryAction")}
              <input
                value={selectedBlock.props.primaryAction}
                onChange={(event) => onUpdateBlock({ primaryAction: event.target.value })}
              />
            </label>
            <label>
              {t("secondaryAction")}
              <input
                value={selectedBlock.props.secondaryAction}
                onChange={(event) => onUpdateBlock({ secondaryAction: event.target.value })}
              />
            </label>
            <label>
              {t("tone")}
              <select
                value={selectedBlock.props.tone}
                onChange={(event) => onUpdateBlock({ tone: event.target.value })}
              >
                {TONE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("density")}
              <select
                value={selectedBlock.props.density}
                onChange={(event) => onUpdateBlock({ density: event.target.value })}
              >
                {DENSITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("layout")}
              <select
                value={selectedBlock.props.alignment}
                onChange={(event) => onUpdateBlock({ alignment: event.target.value })}
              >
                {ALIGNMENT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            {selectedBlock.type !== "navigation" ? (
              <label>
                네비게이션 버튼 이름
                <input
                  value={selectedBlock.props.navigationLabel ?? getBlockNavigationLabel(selectedBlock)}
                  onChange={(event) => onUpdateBlock({ navigationLabel: event.target.value })}
                />
              </label>
            ) : null}
            {layout && design ? (
              <>
                <label>
                  {t("shapeX")}
                  <input
                    type="number"
                    min="0"
                    value={layout.x}
                    onChange={(event) =>
                      onUpdateBlock({
                        layout: {
                          ...layout,
                          x: Math.max(0, Number(event.target.value)),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  {t("shapeY")}
                  <input
                    type="number"
                    min="0"
                    value={layout.y}
                    onChange={(event) =>
                      onUpdateBlock({
                        layout: {
                          ...layout,
                          y: Math.max(0, Number(event.target.value)),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  {t("shapeWidth")}
                  <input
                    type="number"
                    min="24"
                    step="8"
                    value={layout.width}
                    onChange={(event) =>
                      onUpdateBlock({
                        layout: {
                          ...layout,
                          width: Math.max(24, Number(event.target.value)),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  {t("shapeHeight")}
                  <input
                    type="number"
                    min="24"
                    step="8"
                    value={layout.height}
                    onChange={(event) =>
                      onUpdateBlock({
                        layout: {
                          ...layout,
                          height: Math.max(24, Number(event.target.value)),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  {t("shapeFill")}
                  <input
                    type="color"
                    value={design.background}
                    onChange={(event) =>
                      onUpdateBlock({
                        design: {
                          ...design,
                          background: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              </>
            ) : null}
          </>
        )}
      </fieldset>

      <button className="reset-button" type="button" onClick={onReset}>
        {t("resetProject")}
      </button>
    </aside>
  );
}
