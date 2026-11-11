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
