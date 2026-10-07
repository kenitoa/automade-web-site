# Implementation plan

## Objective
Preserve the visual builder workflow and deliver a reliable site authoring system with organized supporting tools and one-click generation/opening.

## Components and data flow
Editor commands -> versioned validated project -> shared runtime -> preview and generated production site -> local export service -> verified artifact -> browser launch.

## Implementation order
1. Establish strict types, validation, compatibility fixtures and automated checks.
2. Implement versioned project model, pages, blocks, layout, actions and safe migrations.
3. Implement shared rendering/actions, real local data persistence and supporting block families.
4. Implement editor history, project recovery, assets, templates, layers, responsive tools and quality diagnostics.
5. Move export into a secured service with atomic writes, source/build artifacts and one-click open.
6. Add structured generation, optional configured external adapters, deployment configuration and documentation.
7. Validate unit/integration/browser/generated-site flows and report remaining external validation honestly.

## Risks
Legacy project conversion, output compatibility, filesystem writes, generated-code isolation, popup restrictions and unavailable toolchains. Preserve legacy source and backups; reject unsafe paths/content; do not execute arbitrary project code; isolate generation and bind local services to loopback.

## Validation
Run lint, strict typecheck, behavioral unit/integration tests, production build, generated output build, browser desktop/mobile workflows, filesystem/security failure tests and git diff --check.

## Rollback
Keep legacy readers and immutable migration backups. Export into uniquely named staging directories and only promote complete results. Keep project schema/generator versions in artifacts. No database reset or existing user-data deletion.
