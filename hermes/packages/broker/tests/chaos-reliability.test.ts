import { describe, expect, it } from 'vitest';
import {
  createGatewayDriftDag,
  createMissingArtifactDag,
  createCausalHealthDag,
  createFlightRecord,
} from '../src/index.js';
import { serviceNow401Fixture, toolHivePortConflictFixture } from './chaos-fixtures.js';

describe('chaos reliability flight recorder and causal health evals', () => {
  it('represents missing volume mount/artifact as the causal DAG root cause', () => {
    const dag = createMissingArtifactDag({
      correlationId: 'corr-missing-mount',
      artifactKind: 'volume_mount',
      summary: 'ToolHive container lacks /root/.ms365-mcp credential mount',
      evidence: {
        missingMount: { sourcePath: '/Users/test/.ms365-mcp', containerPath: '/root/.ms365-mcp' },
        authorization: 'Bearer should-not-leak',
      },
    });

    expect(dag.nodes.map((node) => node.kind)).toEqual([
      'broker',
      'registry',
      'provider_artifacts',
      'toolhive',
      'gateway',
      'operation_proof',
    ]);
    expect(dag.rootCauseSummary).toMatchObject({
      rootCauseNodeIds: ['provider_artifacts'],
      status: 'missing',
      rootCauses: [expect.objectContaining({ kind: 'provider_artifacts', status: 'missing' })],
    });
    expect(dag.rootCauseSummary.summary).toContain('provider/artifacts: missing');
    expect(JSON.stringify(dag)).not.toContain('should-not-leak');
  });

  it('represents gateway reload drift as the causal DAG root cause', () => {
    const dag = createGatewayDriftDag({
      correlationId: 'corr-gateway-drift',
      summary: 'gateway reload drift: serving stale config.generated.json after fleet sync',
      evidence: {
        expectedConfigHash: 'new-hash',
        observedConfigHash: 'old-hash',
        reloadStatus: 'non_ok',
        cookie: 'secret-gateway-cookie',
      },
    });

    expect(dag.rootCauseSummary).toMatchObject({
      rootCauseNodeIds: ['gateway'],
      status: 'degraded',
      rootCauses: [expect.objectContaining({ kind: 'gateway', status: 'degraded' })],
    });
    expect(dag.rootCauseSummary.summary).toContain('gateway reload drift');
    expect(JSON.stringify(dag)).not.toContain('secret-gateway-cookie');
  });

  it('keeps downstream operation failure as root cause only when upstream health is clean', () => {
    const dag = createCausalHealthDag({
      operationProof: { status: 'unhealthy', summary: 'operation contract failed expectedSuccess ladder' },
    });

    expect(dag.rootCauseSummary).toMatchObject({
      rootCauseNodeIds: ['operation_proof'],
      status: 'unhealthy',
    });
  });

  it('provides extendable fixtures for ServiceNow 401 and ToolHive port conflicts', () => {
    const serviceNowRecord = createFlightRecord({
      correlationId: 'corr-servicenow-401',
      tool: 'servicenow_get_incident',
      backendAlias: 'servicenow-mcp',
      canonicalService: 'servicenow',
      scheme: 'oauth',
      failure: { domain: 'auto', evidence: serviceNow401Fixture() },
    });
    const portConflictRecord = createFlightRecord({
      correlationId: 'corr-toolhive-port',
      tool: 'hermes_gateway_probe',
      backendAlias: 'hermes-broker',
      canonicalService: 'hermes',
      scheme: 'local',
      failure: { domain: 'auto', evidence: toolHivePortConflictFixture() },
    });

    expect(serviceNowRecord.failure).toMatchObject({ domain: 'auth', classification: 'auth_recovery', httpStatus: 401 });
    expect(portConflictRecord.failure).toMatchObject({ domain: 'transport', classification: 'port_conflict' });
    expect(JSON.stringify([serviceNowRecord, portConflictRecord])).not.toContain('servicenow-secret-token');
  });
});
