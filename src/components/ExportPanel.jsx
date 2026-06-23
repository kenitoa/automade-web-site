export default function ExportPanel({ project, t }) {
  const spec = JSON.stringify(project, null, 2);

  return (
    <section className="panel export-panel" aria-label="Export specification">
      <div className="panel-header">
        <span className="eyebrow">{t("exportKicker")}</span>
        <h2>{t("exportTitle")}</h2>
      </div>
      <textarea readOnly value={spec} aria-label="Generated interface JSON" />
    </section>
  );
}
