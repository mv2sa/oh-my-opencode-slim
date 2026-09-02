import { describe, expect, mock, test } from 'bun:test';
import { createWaitForUserTool } from './wait-for-user';

describe('wait_for_user tool', () => {
  test('arms the session after validation and tells the orchestrator to end the turn', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    const waitForUser = createWaitForUserTool({
      shouldManageSession: () => true,
      beginUserWait,
    }).wait_for_user;

    const output = await waitForUser.execute(
      { reason: 'Run the deployment steps, then report back.' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );

    expect(beginUserWait).toHaveBeenCalledWith('parent-1');
    expect(String(output)).toContain('state: waiting_for_user');
    expect(String(output)).toContain(
      'protocol: oh-my-opencode-slim.wait_for_user.v1',
    );
    expect(String(output)).toContain('End this turn now');
  });

  test('recovers a display-named orchestrator when the session map is stale', async () => {
    const agentMap = new Map<string, string>();
    const beginUserWait = mock((_sessionID: string) => {});
    const waitForUser = createWaitForUserTool({
      shouldManageSession: (sessionID) =>
        agentMap.get(sessionID) === 'orchestrator',
      resolveAgentName: (agent) =>
        agent === 'engineer' ? 'orchestrator' : agent,
      registerSessionAsOrchestrator: (sessionID) => {
        agentMap.set(sessionID, 'orchestrator');
      },
      beginUserWait,
    }).wait_for_user;

    await waitForUser.execute({ reason: 'Complete the external approval.' }, {
      sessionID: 'parent-1',
      agent: 'engineer',
    } as never);

    expect(beginUserWait).toHaveBeenCalledWith('parent-1');
  });

  test('does not arm rejected invocations', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    const unmanaged = createWaitForUserTool({
      shouldManageSession: () => false,
      beginUserWait,
    }).wait_for_user;
    const managed = createWaitForUserTool({
      shouldManageSession: (sessionID) => sessionID === 'parent-1',
      beginUserWait,
    }).wait_for_user;

    await expect(
      managed.execute({ reason: 'wait' }, { agent: 'orchestrator' } as never),
    ).rejects.toThrow('requires sessionID');
    await expect(
      managed.execute({ reason: 'wait' }, {
        sessionID: 'child-1',
        agent: 'fixer',
      } as never),
    ).rejects.toThrow('orchestrator');
    await expect(
      unmanaged.execute({ reason: 'wait' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('orchestrator sessions');
    await expect(
      managed.execute({ reason: '   ' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('non-empty reason');

    expect(beginUserWait).not.toHaveBeenCalled();
  });

  test('intercepts wait_for_user when background tasks are outstanding', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    const waitForUser = createWaitForUserTool({
      shouldManageSession: () => true,
      beginUserWait,
      waitForUserGuardEnabled: true,
      hasOutstandingBackgroundTasks: () => true,
    }).wait_for_user;

    const output = await waitForUser.execute(
      { reason: 'External approval needed' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );

    expect(beginUserWait).not.toHaveBeenCalled();
    expect(String(output)).toContain('state: waiting_for_user_skipped');
    expect(String(output)).toContain('Background tasks are still outstanding');
    expect(String(output)).toContain('end this turn now');
  });

  test('passes through when no background tasks are outstanding', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    const waitForUser = createWaitForUserTool({
      shouldManageSession: () => true,
      beginUserWait,
      waitForUserGuardEnabled: true,
      hasOutstandingBackgroundTasks: () => false,
    }).wait_for_user;

    const output = await waitForUser.execute(
      { reason: 'Run the deployment steps' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );

    expect(beginUserWait).toHaveBeenCalledWith('parent-1');
    expect(String(output)).toContain('state: waiting_for_user');
  });

  test('passes through when guard is disabled', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    const waitForUser = createWaitForUserTool({
      shouldManageSession: () => true,
      beginUserWait,
      waitForUserGuardEnabled: false,
      hasOutstandingBackgroundTasks: () => true,
    }).wait_for_user;

    const output = await waitForUser.execute(
      { reason: 'Run the deployment steps' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );

    expect(beginUserWait).toHaveBeenCalledWith('parent-1');
    expect(String(output)).toContain('state: waiting_for_user');
  });

  test('validates managed outcome phase and respects background task guard precedence', async () => {
    const beginUserWait = mock((_sessionID: string) => {});
    let allowed = false;
    let hasRunningTasks = false;
    const waitForUser = createWaitForUserTool({
      shouldManageSession: () => true,
      beginUserWait,
      waitForUserGuardEnabled: true,
      hasOutstandingBackgroundTasks: () => hasRunningTasks,
      validateManagedWait: () => ({
        isManaged: true,
        allowed,
        reason: 'Outcome phase is active',
      }),
    }).wait_for_user;

    // 1. Outstanding background task skips before managed wait validation
    hasRunningTasks = true;
    const skippedRes = await waitForUser.execute(
      { reason: 'Wait for human review' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );
    expect(String(skippedRes)).toContain('state: waiting_for_user_skipped');
    expect(beginUserWait).not.toHaveBeenCalled();

    // 2. No background task + not allowed managed wait -> rejected
    hasRunningTasks = false;
    await expect(
      waitForUser.execute({ reason: 'Wait for user' }, {
        sessionID: 'parent-1',
        agent: 'orchestrator',
      } as never),
    ).rejects.toThrow('Outcome phase is active');
    expect(beginUserWait).not.toHaveBeenCalled();

    // 3. No background task + allowed managed wait -> arms wait
    allowed = true;
    const armedRes = await waitForUser.execute(
      { reason: 'Wait for user decision' },
      { sessionID: 'parent-1', agent: 'orchestrator' } as never,
    );
    expect(String(armedRes)).toContain('state: waiting_for_user');
    expect(beginUserWait).toHaveBeenCalledWith('parent-1');
  });
});
