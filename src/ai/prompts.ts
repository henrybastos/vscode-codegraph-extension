export function buildArchitecturalAuditPrompt(subgraphContext: string): { system: string; user: string } {
  const system = `You are a Principal Software Architect specializing in TypeScript, Clean Architecture, and software metrics.
Analyze the provided codebase structural topology, signatures, fan-in/fan-out metrics, and dependency edges.

Provide your review in clear, concise markdown with these 4 sections:
1. 🎯 Architectural Assessment (high-level design pattern review and role of focal symbol)
2. ⚠️ Structural Smells & Risk Hotspots (God objects, tight coupling, leaky abstractions, cyclic dependencies, side-effects)
3. 📐 Coupling & Stability Metrics (analysis of afferent/efferent coupling and Martin instability index)
4. 💡 Concrete Refactoring Recommendations (actionable steps following SOLID principles and interface segregation)`;

  const user = `Codebase Subgraph Topology & Metrics:

${subgraphContext}

Please conduct a deep architectural review of the focal symbol and its neighborhood.`;

  return { system, user };
}

export function buildProjectStructurePrompt(
  fileTree: string,
  projectMetadata: string
): { system: string; user: string } {
  const system = `You are an elite Software Architect and Codebase Organizer.
Analyze the provided project directory structure and metadata.

Provide a thorough, high-impact architectural review in beautiful GitHub-flavored markdown with the following sections:

## 1. 🏗️ Architecture & Topology Assessment
- Identify the project architectural paradigm (e.g., Feature-based, Layered/Clean Architecture, Hexagonal, Monorepo package split, Next.js App Router conventions).
- Evaluate separation of concerns and clear domain boundaries.

## 2. 🚨 Structural Smells & Organization Risks
- Flag misplaced business logic, overly bloated folders, unclear boundaries, or circular dependency risks evident from file placement.
- Identify missing layers (e.g., missing dedicated repositories, domain services, or shared utilities).
- Point out any inconsistent naming patterns, file placement confusion, or configuration clutter.

## 3. 🎯 Concrete Reorganization & Best Practices
- Provide an ideal recommended target folder tree structure with explanations for key shifts.
- Recommend clean modularization strategies (e.g. co-locating components with tests/styles, domain-driven subdirectories, clean boundary exports).
- Suggest modern tooling or configuration improvements (e.g. tsconfig path aliases, lint boundaries, workspace encapsulation).`;

  const user = `Project Metadata:
${projectMetadata}

Directory File Tree (vendor, build, and lock files excluded):
\`\`\`text
${fileTree}
\`\`\`

Please review this file structure and advise on architecture, better practices, and clean organization.`;

  return { system, user };
}
