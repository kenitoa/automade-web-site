export function createProjectExport(project) {
  return {
    schemaVersion: 1,
    kind: "interface-auto-builder.project",
    projectName: project.name,
    canvas: project.canvas,
    theme: project.theme,
    blocks: project.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      name: block.name,
      componentName: block.logic.componentName,
      layout: block.layout,
      props: block.props,
      design: block.design,
      logic: block.logic,
      generatedFiles: createGeneratedFiles(block),
    })),
  };
}

function createGeneratedFiles(block) {
  const componentName = block.logic.componentName;
  const className = `generated-${block.type}-${block.id.slice(0, 8)}`;

  return {
    react: {
      path: `src/generated/${componentName}.jsx`,
      code: createReactComponent(block, className),
    },
    css: {
      path: `src/generated/${componentName}.css`,
      code: createCss(block, className),
    },
  };
}

function createReactComponent(block, className) {
  const events = block.logic.events
    .map((event) => `  function ${event.name}() {\n    // ${event.effect}\n  }`)
    .join("\n\n");

  return `import "./${block.logic.componentName}.css";

export default function ${block.logic.componentName}() {
${events || "  // No custom events required."}

  return (
    <section className="${className}">
      <h2>${escapeJsx(block.props.title)}</h2>
      <p>${escapeJsx(block.props.body)}</p>
      <div className="${className}__actions">
        <button type="button" onClick={${block.logic.events[0]?.name ?? "() => {}"}}>
          ${escapeJsx(block.props.primaryAction)}
        </button>
        <button type="button" onClick={${block.logic.events[1]?.name ?? "() => {}"}}>
          ${escapeJsx(block.props.secondaryAction)}
        </button>
      </div>
    </section>
  );
}
`;
}

function createCss(block, className) {
  const style = block.design;

  return `.${className} {
  position: ${block.layout.position};
  left: ${block.layout.x}px;
  top: ${block.layout.y}px;
  width: ${block.layout.width}px;
  height: ${block.layout.height}px;
  z-index: ${block.layout.zIndex};
  display: ${style.display};
  gap: ${style.gap}px;
  padding: ${style.padding}px;
  border-radius: ${style.radius}px;
  background: ${style.background};
  border: ${style.border};
  color: ${style.color};
${style.shadow ? `  box-shadow: ${style.shadow};\n` : ""}}

.${className}__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
`;
}

function escapeJsx(value) {
  return String(value ?? "").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
}
