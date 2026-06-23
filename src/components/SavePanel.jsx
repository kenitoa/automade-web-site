export default function SavePanel({ project, saveStatus, t, onUpdateName, onSave }) {
  return (
    <section className="panel save-panel" aria-label="Desktop save">
      <div className="panel-header">
        <div>
          <span className="eyebrow">{t("saveKicker")}</span>
          <h2>{t("saveTitle")}</h2>
        </div>
      </div>
      <div className="save-body">
        <label>
          {t("projectName")}
          <input value={project.name} onChange={(event) => onUpdateName(event.target.value)} />
        </label>
        <button type="button" onClick={onSave} disabled={saveStatus.state === "saving"}>
          {saveStatus.state === "saving" ? t("saveSaving") : t("saveDesktop")}
        </button>
        <p className={`save-status ${saveStatus.state}`}>
          {saveStatus.message || t("saveReady")}
        </p>
      </div>
    </section>
  );
}
