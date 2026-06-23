import { useEffect, useMemo, useState } from "react";
import BuilderCanvas from "./components/BuilderCanvas.jsx";
import ExportPanel from "./components/ExportPanel.jsx";
import Inspector from "./components/Inspector.jsx";
import Palette from "./components/Palette.jsx";
import Preview from "./components/Preview.jsx";
import SavePanel from "./components/SavePanel.jsx";
import { createProjectExport } from "./lib/exportSpec.js";
import { createTranslator } from "./lib/i18n.js";
import { createPreviewDocument, createReactProjectFiles, createSiteFiles } from "./lib/siteExport.js";
import {
  createProject,
  placeBlock,
  removeBlock,
  updateBlock,
  updateCanvas,
  updateSettings,
  updateTheme,
} from "./lib/projectModel.js";
import { clearProject, loadProject, saveProject } from "./lib/storage.js";

export default function App() {
  const [project, setProject] = useState(() => loadProject());
  const [selectedId, setSelectedId] = useState(project.blocks[0]?.id ?? null);
  const [placementType, setPlacementType] = useState("hero");
  const [saveStatus, setSaveStatus] = useState({ state: "idle", message: "" });
  const [rightPanelMode, setRightPanelMode] = useState("preview");

  const selectedBlock = useMemo(
    () => project.blocks.find((block) => block.id === selectedId) ?? null,
    [project.blocks, selectedId],
  );
  const t = useMemo(() => createTranslator(project.settings), [project.settings]);
  const exportSpec = useMemo(() => createProjectExport(project), [project]);
  const siteFiles = useMemo(() => createSiteFiles(project), [project]);
  const previewDocument = useMemo(() => createPreviewDocument(project), [project]);
  const reactProjectFiles = useMemo(() => createReactProjectFiles(project), [project]);

  useEffect(() => {
    saveProject(project);
  }, [project]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase();
      const isEditing =
        target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";

      if (isEditing) {
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        handleRemoveBlock(selectedId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [project, selectedId]);

  function handlePlaceBlock(point, explicitType = placementType) {
    if (!explicitType) {
      return;
    }

    const result = placeBlock(project, explicitType, point);
    setProject(result.project);
    setSelectedId(result.block.id);
  }

  function handleRemoveBlock(blockId) {
    const nextProject = removeBlock(project, blockId);
    setProject(nextProject);

    if (selectedId === blockId) {
      setSelectedId(nextProject.blocks[0]?.id ?? null);
    }
  }

  function handleUpdateBlock(updates) {
    if (!selectedBlock) {
      return;
    }

    setProject(updateBlock(project, selectedBlock.id, updates));
  }

  function handleUpdateBlockLayout(blockId, layout) {
    setProject(updateBlock(project, blockId, { layout }));
  }

  function handleUpdateTheme(updates) {
    if (Object.hasOwn(updates, "projectName")) {
      setProject({
        ...project,
        name: updates.projectName,
      });
      return;
    }

    setProject(updateTheme(project, updates));
  }

  function handleUpdateSettings(updates) {
    setProject(updateSettings(project, updates));
  }

  function handleUpdateCanvas(updates) {
    setProject(updateCanvas(project, updates));
  }

  async function handleSaveToDesktop() {
    setSaveStatus({ state: "saving", message: t("saveSaving") });

    try {
      const response = await fetch("/api/save-project", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project, exportSpec, siteFiles, reactProjectFiles }),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Save failed");
      }

      setSaveStatus({
        state: "done",
        message: `${t("saveDone")}: ${result.entry ?? result.path}`,
      });
    } catch (error) {
      setSaveStatus({
        state: "failed",
        message: `${t("saveFailed")}: ${error.message}`,
      });
    }
  }

  function handleOpenPreviewWindow() {
    const width = Math.min(Math.max(project.canvas.width + 80, 900), 1600);
    const height = Math.min(Math.max(project.canvas.height + 90, 700), 1000);
    const popup = window.open("", "_blank", `width=${width},height=${height},resizable=yes,scrollbars=yes`);

    if (!popup) {
      setSaveStatus({
        state: "failed",
        message: "미리 보기 창이 차단되었습니다. 브라우저 팝업 허용 후 다시 눌러주세요.",
      });
      return;
    }

    const previewUrl = URL.createObjectURL(new Blob([previewDocument], { type: "text/html;charset=utf-8" }));
    popup.location.href = previewUrl;
    window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
    popup.focus();
  }

  function handleReset() {
    clearProject();
    const nextProject = createProject();
    setProject(nextProject);
    setSelectedId(null);
    setSaveStatus({ state: "idle", message: "" });
    setPlacementType("hero");
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <span className="eyebrow">{t("appKicker")}</span>
          <h1>{t("appTitle")}</h1>
        </div>
        <div className="top-status">
          <span>
            {project.blocks.length} {t("blockCount")}
          </span>
          <span>{selectedBlock ? `${selectedBlock.type} ${t("selected")}` : t("noSelection")}</span>
        </div>
      </header>

      <div className="builder-layout">
        <Palette selectedType={placementType} onSelectBlockType={setPlacementType} t={t} />
        <div className="workspace-column">
          <BuilderCanvas
            project={project}
            selectedId={selectedId}
            placementType={placementType}
            t={t}
            onSelect={setSelectedId}
            onPlaceBlock={handlePlaceBlock}
            onUpdateBlockLayout={handleUpdateBlockLayout}
            onUpdateCanvas={handleUpdateCanvas}
          />
        </div>
        <div className="side-column">
          <SavePanel
            project={project}
            saveStatus={saveStatus}
            t={t}
            onUpdateName={(name) => handleUpdateTheme({ projectName: name })}
            onSave={handleSaveToDesktop}
          />
          <Inspector
            project={project}
            selectedBlock={selectedBlock}
            t={t}
            onUpdateBlock={handleUpdateBlock}
            onUpdateTheme={handleUpdateTheme}
            onUpdateSettings={handleUpdateSettings}
            onReset={handleReset}
          />
          <div className="side-tabs" role="tablist" aria-label="Right panel mode">
            <button
              className={rightPanelMode === "preview" ? "active" : ""}
              type="button"
              onClick={handleOpenPreviewWindow}
            >
              미리 보기
            </button>
            <button
              className={rightPanelMode === "spec" ? "active" : ""}
              type="button"
              onClick={() => setRightPanelMode("spec")}
            >
              스펙 보기
            </button>
          </div>
          {rightPanelMode === "preview" ? <Preview project={project} t={t} /> : <ExportPanel project={exportSpec} t={t} />}
        </div>
      </div>
    </main>
  );
}
