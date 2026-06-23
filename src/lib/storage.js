import { createProject, sanitizeProject } from "./projectModel.js";

const STORAGE_KEY = "interface-auto-builder.project";

export function loadProject() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeProject(JSON.parse(raw)) : createProject();
  } catch {
    return createProject();
  }
}

export function saveProject(project) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}

export function clearProject() {
  window.localStorage.removeItem(STORAGE_KEY);
}
