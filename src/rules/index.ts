import { GodFileRule } from './catalog/god-file.rule.js';
import { CircularCouplingRule } from './catalog/circular-coupling.rule.js';
import { LayerBypassRule } from './catalog/layer-bypass.rule.js';
import { MixedConcernsRule } from './catalog/mixed-concerns.rule.js';
import { UnstableFoundationRule } from './catalog/unstable-foundation.rule.js';
import { FeatureEnvyRule } from './catalog/feature-envy.rule.js';
import { DeadAbstractionRule } from './catalog/dead-abstraction.rule.js';
import { ApiDecompositionRule } from './catalog/api-decomposition.rule.js';
import type { ArchitectureRule } from './types.js';

export * from './types.js';
export * from './engine.js';
export {
  GodFileRule,
  CircularCouplingRule,
  LayerBypassRule,
  MixedConcernsRule,
  UnstableFoundationRule,
  FeatureEnvyRule,
  DeadAbstractionRule,
  ApiDecompositionRule
};

export const DEFAULT_RULES: ArchitectureRule[] = [
  new CircularCouplingRule(),
  new LayerBypassRule(),
  new GodFileRule(),
  new MixedConcernsRule(),
  new UnstableFoundationRule(),
  new FeatureEnvyRule(),
  new DeadAbstractionRule(),
  new ApiDecompositionRule()
];
