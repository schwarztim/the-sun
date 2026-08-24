import { redactFlightRecorderValue, type FlightRecorderJsonValue } from './flight-recorder.js';

export type CausalHealthNodeKind = 'broker' | 'registry' | 'provider_artifacts' | 'toolhive' | 'gateway' | 'operation_proof';
export type CausalHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'missing' | 'unknown';

export interface CausalHealthNode {
  id: string;
  kind: CausalHealthNodeKind;
  label: string;
  status: CausalHealthStatus;
  at?: number;
  summary?: string;
  evidence?: FlightRecorderJsonValue;
}

export interface CausalHealthEdge {
  from: string;
  to: string;
  relationship: 'depends_on' | 'feeds' | 'validates';
}

export interface CausalRootCauseSummary {
  rootCauseNodeIds: string[];
  rootCauses: CausalHealthNode[];
  status: CausalHealthStatus;
  summary: string;
}

export interface CausalHealthDag {
  dagType: 'hermes.causal_health';
  correlationId?: string;
  nodes: CausalHealthNode[];
  edges: CausalHealthEdge[];
  rootCauseSummary: CausalRootCauseSummary;
}

export interface CausalHealthNodeInput {
  id?: string;
  label?: string;
  status: CausalHealthStatus;
  at?: number;
  summary?: string;
  evidence?: unknown;
}

export interface CausalHealthDagInput {
  correlationId?: string;
  broker?: CausalHealthStatus | CausalHealthNodeInput;
  registry?: CausalHealthStatus | CausalHealthNodeInput;
  providerArtifacts?: CausalHealthStatus | CausalHealthNodeInput;
  toolhive?: CausalHealthStatus | CausalHealthNodeInput;
  gateway?: CausalHealthStatus | CausalHealthNodeInput;
  operationProof?: CausalHealthStatus | CausalHealthNodeInput;
  edges?: CausalHealthEdge[];
}

const DEFAULT_ORDER: readonly CausalHealthNodeKind[] = ['broker', 'registry', 'provider_artifacts', 'toolhive', 'gateway', 'operation_proof'];
const DEFAULT_LABELS: Record<CausalHealthNodeKind, string> = {
  broker: 'broker',
  registry: 'registry',
  provider_artifacts: 'provider/artifacts',
  toolhive: 'ToolHive',
  gateway: 'gateway',
  operation_proof: 'operation proof',
};

const DEFAULT_EDGES: CausalHealthEdge[] = [
  { from: 'broker', to: 'registry', relationship: 'feeds' },
  { from: 'registry', to: 'provider_artifacts', relationship: 'feeds' },
  { from: 'provider_artifacts', to: 'toolhive', relationship: 'feeds' },
  { from: 'toolhive', to: 'gateway', relationship: 'feeds' },
  { from: 'gateway', to: 'operation_proof', relationship: 'validates' },
];

function isNodeInput(value: CausalHealthStatus | CausalHealthNodeInput | undefined): value is CausalHealthNodeInput {
  return Boolean(value) && typeof value === 'object';
}

function sanitizeSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactFlightRecorderValue(value);
  return typeof redacted === 'string' ? redacted.slice(0, 500) : undefined;
}

function nodeFromInput(kind: CausalHealthNodeKind, input: CausalHealthStatus | CausalHealthNodeInput | undefined): CausalHealthNode {
  const nodeInput = isNodeInput(input) ? input : { status: input ?? 'unknown' };
  const node: CausalHealthNode = {
    id: nodeInput.id ?? kind,
    kind,
    label: nodeInput.label ?? DEFAULT_LABELS[kind],
    status: nodeInput.status,
  };
  if (nodeInput.at !== undefined) node.at = nodeInput.at;
  const summary = sanitizeSummary(nodeInput.summary);
  if (summary !== undefined) node.summary = summary;
  if (nodeInput.evidence !== undefined) node.evidence = redactFlightRecorderValue(nodeInput.evidence);
  return node;
}

function statusRank(status: CausalHealthStatus): number {
  switch (status) {
    case 'unhealthy': return 5;
    case 'missing': return 4;
    case 'degraded': return 3;
    case 'unknown': return 2;
    case 'healthy': return 1;
  }
}

function worstStatus(nodes: CausalHealthNode[]): CausalHealthStatus {
  return nodes.reduce<CausalHealthStatus>((worst, node) => (statusRank(node.status) > statusRank(worst) ? node.status : worst), 'healthy');
}

function isCausalFailure(status: CausalHealthStatus): boolean {
  return status === 'degraded' || status === 'unhealthy' || status === 'missing';
}

function ancestorIds(nodeId: string, incoming: Map<string, string[]>, seen = new Set<string>()): Set<string> {
  const parents = incoming.get(nodeId) ?? [];
  for (const parent of parents) {
    if (!seen.has(parent)) {
      seen.add(parent);
      ancestorIds(parent, incoming, seen);
    }
  }
  return seen;
}

export function summarizeCausalHealthDag(nodes: CausalHealthNode[], edges: CausalHealthEdge[]): CausalRootCauseSummary {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const failing = nodes.filter((node) => isCausalFailure(node.status));
  const rootCauses = failing.filter((node) => {
    const ancestors = ancestorIds(node.id, incoming);
    return !Array.from(ancestors).some((id) => {
      const ancestor = byId.get(id);
      return ancestor ? isCausalFailure(ancestor.status) : false;
    });
  });
  const selected = rootCauses.length > 0 ? rootCauses : failing;
  const status = worstStatus(selected.length > 0 ? selected : nodes);
  const summary = selected.length === 0
    ? 'No causal health root cause detected.'
    : selected.map((node) => `${node.label}: ${node.status}${node.summary ? ` (${node.summary})` : ''}`).join('; ');

  return {
    rootCauseNodeIds: selected.map((node) => node.id),
    rootCauses: selected,
    status,
    summary,
  };
}

export function createCausalHealthDag(input: CausalHealthDagInput = {}): CausalHealthDag {
  const nodes = DEFAULT_ORDER.map((kind) => {
    switch (kind) {
      case 'broker': return nodeFromInput(kind, input.broker ?? 'healthy');
      case 'registry': return nodeFromInput(kind, input.registry ?? 'healthy');
      case 'provider_artifacts': return nodeFromInput(kind, input.providerArtifacts ?? 'healthy');
      case 'toolhive': return nodeFromInput(kind, input.toolhive ?? 'healthy');
      case 'gateway': return nodeFromInput(kind, input.gateway ?? 'healthy');
      case 'operation_proof': return nodeFromInput(kind, input.operationProof ?? 'healthy');
    }
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (input.edges ?? DEFAULT_EDGES).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const dag: CausalHealthDag = {
    dagType: 'hermes.causal_health',
    nodes,
    edges,
    rootCauseSummary: summarizeCausalHealthDag(nodes, edges),
  };
  if (input.correlationId !== undefined) dag.correlationId = input.correlationId;
  return dag;
}

export function createMissingArtifactDag(opts: {
  correlationId?: string;
  artifactKind?: string;
  summary?: string;
  evidence?: unknown;
} = {}): CausalHealthDag {
  return createCausalHealthDag({
    correlationId: opts.correlationId,
    providerArtifacts: {
      status: 'missing',
      summary: opts.summary ?? `${opts.artifactKind ?? 'credential artifact'} missing`,
      evidence: opts.evidence,
    },
    toolhive: { status: 'degraded', summary: 'ToolHive cannot receive missing credential artifact' },
    gateway: 'unknown',
    operationProof: { status: 'unhealthy', summary: 'operation proof cannot be established' },
  });
}

export function createGatewayDriftDag(opts: {
  correlationId?: string;
  summary?: string;
  evidence?: unknown;
} = {}): CausalHealthDag {
  return createCausalHealthDag({
    correlationId: opts.correlationId,
    gateway: {
      status: 'degraded',
      summary: opts.summary ?? 'gateway reload drift detected',
      evidence: opts.evidence,
    },
    operationProof: { status: 'unhealthy', summary: 'operation proof failed behind stale gateway fleet state' },
  });
}
