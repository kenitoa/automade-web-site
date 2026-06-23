import { BLOCK_CATALOG } from "../data/blockCatalog.js";

export default function Palette({ selectedType, onSelectBlockType, t }) {
  return (
    <aside className="panel palette-panel" aria-label="Block palette">
      <div className="panel-header">
        <span className="eyebrow">{t("paletteKicker")}</span>
        <h2>{t("paletteTitle")}</h2>
      </div>

      <div className="palette-list">
        {BLOCK_CATALOG.map((block) => (
          <button
            className={`palette-item ${selectedType === block.type ? "active" : ""}`}
            draggable
            key={block.type}
            type="button"
            onClick={() => onSelectBlockType(block.type)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("application/x-interface-block", block.type);
              onSelectBlockType(block.type);
            }}
          >
            <span className="palette-item-name">{block.name}</span>
            <span className="palette-item-description">{block.description}</span>
            <span className="palette-item-size">
              {block.size.width} x {block.size.height}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
