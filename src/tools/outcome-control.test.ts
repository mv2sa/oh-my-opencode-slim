import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutcomeController } from '../outcome/controller';
import {
  canonicalDigest,
  type OutcomeContract,
  OutcomeContractSchema,
} from '../outcome/controller-schema';
import { createOutcomeControlTool } from './outcome-control';

const hash = (value: string) => canonicalDigest('test/v1', value);

function sampleContract(): OutcomeContract {
  return OutcomeContractSchema.parse({
    classification: 'non_trivial',
    objective: 'Test outcome control tool',
    deliverables: ['deliverable-1'],
    goals: [
      {
        id: 'goal-1',
        description: 'Test goal',
        status: 'in_progress',
      },
    ],
    inScope: ['src/tools'],
    outOfScope: ['other packages'],
    constraints: ['No unreviewed volatile inputs'],
    safetyBoundaries: ['Do not forge attestations'],
    handoffRequirements: ['Verification steps provided'],
    sourceMessageIds: ['msg_1'],
    rules: [],
    exceptions: [],
  });
}

describe('outcome_control tool', () => {
  let tempDir: string;
  let controller: OutcomeController;
  let managedMap: Set<string>;
  let toolInstance: ReturnType<
    typeof createOutcomeControlTool
  >['outcome_control'];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tool-test-'));
    controller = new OutcomeController({ storeDirectory: tempDir });
    managedMap = new Set<string>(['ses_root']);
    toolInstance = createOutcomeControlTool({
      controller,
      shouldManageSession: (id) => managedMap.has(id),
      resolveAgentName: (agent) =>
        agent === 'engineer' ? 'orchestrator' : agent,
    }).outcome_control;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('enforces explicit orchestrator authority and rejects absent agent, specialists, and unmanaged sessions', async () => {
    // Absent caller agent
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
      } as never),
    ).rejects.toThrow('requires an explicit caller agent');

    // Empty caller agent
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: '   ',
      } as never),
    ).rejects.toThrow('requires an explicit caller agent');

    // Non-orchestrator agent (fixer)
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: 'fixer',
      } as never),
    ).rejects.toThrow('outcome_control can only be used by orchestrator');

    // Outcome Manager
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_root',
        agent: 'outcome-manager',
      } as never),
    ).rejects.toThrow('outcome_control can only be used by orchestrator');

    // Unmanaged session
    await expect(
      toolInstance.execute({ action: 'status' }, {
        sessionID: 'ses_unmanaged',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('not managed');

    // Missing sessionID
    await expect(
      toolInstance.execute({ action: 'status' }, {
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('requires sessionID');

    // Managed orchestrator allowed
    const statusOutput = await toolInstance.execute({ action: 'status' }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);
    expect(String(statusOutput)).toContain('"isManaged": false');
  });

  test('begin action requires explicit non_trivial classification and complete contract', async () => {
    const invalidContract = {
      classification: 'trivial',
      objective: 'Trivial task',
    };

    await expect(
      toolInstance.execute(
        { action: 'begin', contract: invalidContract as never },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('non_trivial');

    const validContract = sampleContract();
    const beginOutput = await toolInstance.execute(
      { action: 'begin', contract: validContract },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    const parsed = JSON.parse(String(beginOutput));
    expect(parsed.outcomeId).toBeDefined();
    expect(parsed.checkpoint.kind).toBe('kickoff');
    expect(parsed.dispatchNudgePending).toBe(true);
    expect(String(beginOutput)).not.toContain('OMOS_DISPATCH_MARKER');
    expect(String(beginOutput)).not.toContain('claimToken');
  });

  test('checkpoint and submit_evidence actions work as expected', async () => {
    let mockTime = 1000;
    const timeController = new OutcomeController({
      storeDirectory: tempDir,
      clock: () => mockTime,
    });
    const timedTool = createOutcomeControlTool({
      controller: timeController,
      shouldManageSession: (id) => managedMap.has(id),
    }).outcome_control;

    // Begin first
    await timedTool.execute({ action: 'begin', contract: sampleContract() }, {
      sessionID: 'ses_root',
      agent: 'orchestrator',
    } as never);

    // Advance time past expiry
    mockTime += 700_000;

    // Expire kickoff checkpoint to allow second checkpoint
    await timedTool.execute(
      {
        action: 'expire_checkpoint',
        checkpointId:
          timeController.getStatus('ses_root').checkpoint?.checkpointId,
        reason: 'Expired for testing',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    const candidateFingerprint = hash('git_sha_123');
    const chkOutput = await timedTool.execute(
      {
        action: 'checkpoint',
        kind: 'decision',
        reason: 'Architecture decision needed',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const chkParsed = JSON.parse(String(chkOutput));
    expect(chkParsed.kind).toBe('decision');
    expect(chkParsed.dispatchNudgePending).toBe(true);
    expect(String(chkOutput)).not.toContain('OMOS_DISPATCH_MARKER');

    // Submit evidence
    const evOutput = await timedTool.execute(
      {
        action: 'submit_evidence',
        description: 'bun test src/tools',
        assertedStatus: 'passed',
        assertedFreshness: 'fresh',
        candidateFingerprint,
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const evParsed = JSON.parse(String(evOutput));
    expect(evParsed.assurance).toBe('orchestrator_attestation');
    expect(evParsed.attestationId).toBeDefined();
  });

  test('external_handoff action sets waiting_external', async () => {
    await toolInstance.execute(
      { action: 'begin', contract: sampleContract() },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );

    const handoffOutput = await toolInstance.execute(
      {
        action: 'external_handoff',
        handoffKind: 'restart_current_opencode',
        instructions: 'Restart opencode CLI',
        expectedPostRestartCheck: 'Confirm version 2.2.18',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const handoffParsed = JSON.parse(String(handoffOutput));
    expect(handoffParsed.phase).toBe('waiting_external');
    expect(handoffParsed.instructions).toBe('Restart opencode CLI');
  });

  test('register_repository_waiver exposes only bounded repository authority', async () => {
    await toolInstance.execute(
      { action: 'begin', contract: sampleContract() },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const output = await toolInstance.execute(
      {
        action: 'register_repository_waiver',
        repositoryReference: 'governance/waivers/test.json',
      },
      { sessionID: 'ses_root', agent: 'orchestrator' } as never,
    );
    const parsed = JSON.parse(String(output));
    expect(parsed.kind).toBe('repository_waiver');
    expect(parsed.authorizationId).toMatch(/^auth_/);
    expect(parsed.payloadDigest).toMatch(/^sha256:/);
    await expect(
      toolInstance.execute(
        { action: 'register_repository_waiver', repositoryReference: '   ' },
        { sessionID: 'ses_root', agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('Repository waiver reference must contain');
  });
});
