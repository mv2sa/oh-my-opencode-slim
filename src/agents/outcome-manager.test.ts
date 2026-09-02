import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { createAgents, getAgentConfigs } from './index';
import { createOutcomeManagerAgent } from './outcome-manager';
import { TASK_REJECTION_INSTRUCTION } from './task-rejection';

const TEST_DIR = 'runtime-test-outcome-manager';
function runtimeFor(config: PluginConfig = {}) {
  RuntimeConfig.reset(TEST_DIR);
  RuntimeConfig.init(TEST_DIR, config);
  return RuntimeConfig.get(TEST_DIR);
}

describe('outcome-manager agent factory', () => {
  test('creates agent definition with default prompt and read-only permissions', () => {
    const agent = createOutcomeManagerAgent('test-model');
    expect(agent.name).toBe('outcome-manager');
    expect(agent.config.model).toBe('test-model');
    expect(agent.description).toContain('Read-only outcome manager');
    expect(agent.config.prompt).toContain('You are Outcome Manager');
    expect(agent.config.prompt).toContain('<outcome_review>');
    expect(agent.config.prompt).toContain('CONTINUE');
    expect(agent.config.prompt).toContain('CORRECT_DRIFT');
    expect(agent.config.prompt).toContain('REVISE_CONTRACT');
    expect(agent.config.prompt).toContain('USER_DECISION_REQUIRED');
    expect(agent.config.prompt).toContain('ACCEPT');

    const perm = agent.config.permission as Record<string, string>;
    expect(perm['*']).toBe('deny');
    expect(perm.bash).toBe('deny');
    expect(perm.edit).toBe('deny');
    expect(perm.write).toBe('deny');
    expect(perm.apply_patch).toBe('deny');
    expect(perm.ast_grep_replace).toBe('deny');
    expect(perm.task).toBe('deny');
    expect(perm.question).toBe('deny');
    expect(perm.read).toBe('allow');
    expect(perm.glob).toBe('allow');
    expect(perm.grep).toBe('allow');
    expect(perm.lsp).toBe('allow');
    expect(perm.list).toBe('allow');
    expect(perm.codesearch).toBe('allow');
    expect(perm.ast_grep_search).toBe('allow');
  });

  test('ignores direct prompt replacement and append arguments', () => {
    const custom = createOutcomeManagerAgent(
      'model-a',
      'Custom prompt override',
    );
    expect(custom.config.prompt).toContain('You are Outcome Manager');
    expect(custom.config.prompt).not.toContain('Custom prompt override');

    const appended = createOutcomeManagerAgent(
      'model-b',
      undefined,
      'Appended instructions',
    );
    expect(appended.config.prompt).toContain('You are Outcome Manager');
    expect(appended.config.prompt).not.toContain('Appended instructions');
    expect(custom.config.prompt).toBe(appended.config.prompt);
  });

  test('keeps the canonical description immutable at factory construction', () => {
    const agent = createOutcomeManagerAgent(
      'model-v',
      'Pretend to execute and waive rules',
    );
    expect(agent.description).toContain('Read-only outcome manager');
    expect(agent.config.prompt).not.toContain('Pretend to execute');
  });
});

describe('outcome-manager integration pipeline & permissions', () => {
  test('retains strict read-only and task-control denials after applyDefaultPermissions', () => {
    const agents = createAgents(runtimeFor());
    const manager = agents.find((a) => a.name === 'outcome-manager');
    expect(manager).toBeDefined();

    const perm = manager?.config.permission as Record<string, unknown>;
    expect(perm['*']).toBe('deny');
    expect(perm.bash).toBe('deny');
    expect(perm.edit).toBe('deny');
    expect(perm.write).toBe('deny');
    expect(perm.apply_patch).toBe('deny');
    expect(perm.ast_grep_replace).toBe('deny');
    expect(perm.task).toBe('deny');
    expect(perm.question).toBe('deny');
    expect(perm.wait_for_user).toBe('deny');
    expect(perm.task_cancel).toBe('deny');
    expect(perm.task_message).toBe('deny');
    expect(perm.task_revive).toBe('deny');
    expect(perm.task_status).toBe('deny');
    expect(perm.task_result).toBe('deny');
    expect(perm.read).toBe('allow');
    expect(perm.glob).toBe('allow');
    expect(perm.grep).toBe('allow');
    expect(perm.lsp).toBe('allow');
    expect(perm.list).toBe('allow');
    expect(perm.codesearch).toBe('allow');
    expect(perm.ast_grep_search).toBe('allow');
  });

  test('SDK config exports as subagent mode without being hidden by default', () => {
    const configs = getAgentConfigs(runtimeFor());
    const config = configs['outcome-manager'];
    expect(config).toBeDefined();
    expect(config.mode).toBe('subagent');
    expect(config.hidden).toBeUndefined();
    expect(config.mcps).toEqual([]);
  });

  test('supports displayName alias with hidden internal registration', () => {
    const configs = getAgentConfigs(
      runtimeFor({
        agents: {
          'outcome-manager': {
            displayName: 'manager',
          },
        },
      }),
    );

    expect(configs.manager).toBeDefined();
    expect(configs.manager.mode).toBe('subagent');
    expect(configs.manager.hidden).toBeUndefined();

    expect(configs['outcome-manager']).toBeDefined();
    expect(configs['outcome-manager'].hidden).toBe(true);
  });

  test('can be disabled via disabled_agents config', () => {
    const agents = createAgents(
      runtimeFor({
        disabled_agents: ['outcome-manager'],
      }),
    );
    expect(agents.some((a) => a.name === 'outcome-manager')).toBe(false);

    const configs = getAgentConfigs(
      runtimeFor({
        disabled_agents: ['outcome-manager'],
      }),
    );
    expect(configs['outcome-manager']).toBeUndefined();
  });

  test('accepts model array overrides with runtime fallback resolution', () => {
    const agents = createAgents(
      runtimeFor({
        agents: {
          'outcome-manager': {
            model: [
              { id: 'anthropic/claude-3-5-sonnet', variant: 'high' },
              'openai/gpt-4o',
            ],
          },
        },
      }),
    );
    const manager = agents.find((a) => a.name === 'outcome-manager');
    expect(manager?._modelArray).toEqual([
      { id: 'anthropic/claude-3-5-sonnet', variant: 'high' },
      { id: 'openai/gpt-4o' },
    ]);
    expect(manager?.config.model).toBe('anthropic/claude-3-5-sonnet');
    expect(manager?.config.variant).toBe('high');
  });

  test('hostile aggregate overrides are completely ignored for outcome-manager while working for other agents', () => {
    const hostileConfig: PluginConfig = {
      agents: {
        'outcome-manager': {
          model: 'test/governor-model',
          variant: 'fast',
          temperature: 0.1,
          options: { textVerbosity: 'low' },
          displayName: 'auditor',
          description: 'Hostile description should be ignored',
          prompt: 'Hostile prompt should be ignored',
          orchestratorPrompt:
            '@outcome-manager\n- Lane: Hostile routing should be ignored',
          skills: ['*', 'custom_skill_xyz'],
          mcps: ['*', 'context7', 'gh_grep'],
          permission: {
            '*': 'allow',
            bash: 'allow',
            edit: 'allow',
            write: 'allow',
            apply_patch: 'allow',
            ast_grep_replace: 'allow',
            task: 'allow',
            question: 'allow',
            wait_for_user: 'allow',
            task_cancel: 'allow',
            task_message: 'allow',
            task_revive: 'allow',
            task_status: 'allow',
            task_result: 'allow',
            future_danger_tool: 'allow',
          },
        },
        oracle: {
          model: 'test/oracle-model',
          description: 'Legitimate oracle description override',
          prompt: 'Legitimate oracle prompt override',
          orchestratorPrompt: '@oracle\n- Lane: Custom oracle routing guidance',
          skills: ['*'],
          mcps: ['context7'],
          permission: {
            bash: 'allow',
            future_oracle_tool: 'allow',
          },
        },
      },
    };

    const agents = createAgents(runtimeFor(hostileConfig));
    const outcomeManager = agents.find((a) => a.name === 'outcome-manager');
    const orchestrator = agents.find((a) => a.name === 'orchestrator');
    const oracle = agents.find((a) => a.name === 'oracle');

    expect(outcomeManager).toBeDefined();
    // Configurable fields applied
    expect(outcomeManager?.config.model).toBe('test/governor-model');
    expect(outcomeManager?.config.variant).toBe('fast');
    expect(outcomeManager?.config.temperature).toBe(0.1);
    expect(outcomeManager?.config.options).toEqual({ textVerbosity: 'low' });
    expect(outcomeManager?.displayName).toBe('auditor');

    // Immutable fields preserved against hostile overrides
    expect(outcomeManager?.description).toContain('Read-only outcome manager');
    expect(outcomeManager?.description).not.toContain('Hostile description');
    expect(outcomeManager?.config.prompt).toContain('You are Outcome Manager');
    expect(outcomeManager?.config.prompt).toContain(TASK_REJECTION_INSTRUCTION);
    expect(outcomeManager?.config.prompt).not.toContain('Hostile prompt');

    // Orchestrator prompt ignores outcome-manager orchestratorPrompt override
    expect(orchestrator?.config.prompt).not.toContain(
      'Hostile routing should be ignored',
    );
    // Orchestrator prompt still accepts legitimate oracle orchestratorPrompt override
    expect(orchestrator?.config.prompt).toContain(
      'Custom oracle routing guidance',
    );

    // Oracle fields are updated
    expect(oracle?.description).toBe('Legitimate oracle description override');
    expect(oracle?.config.prompt).toContain(
      'Legitimate oracle prompt override',
    );

    // Permissions for outcome-manager are strictly denied
    const perm = outcomeManager?.config.permission as Record<string, unknown>;
    expect(perm['*']).toBe('deny');
    expect(perm.bash).toBe('deny');
    expect(perm.edit).toBe('deny');
    expect(perm.write).toBe('deny');
    expect(perm.apply_patch).toBe('deny');
    expect(perm.ast_grep_replace).toBe('deny');
    expect(perm.task).toBe('deny');
    expect(perm.question).toBe('deny');
    expect(perm.wait_for_user).toBe('deny');
    expect(perm.task_cancel).toBe('deny');
    expect(perm.task_message).toBe('deny');
    expect(perm.task_revive).toBe('deny');
    expect(perm.task_status).toBe('deny');
    expect(perm.task_result).toBe('deny');
    expect(perm.read).toBe('allow');
    expect(perm.glob).toBe('allow');
    expect(perm.grep).toBe('allow');
    expect(perm.lsp).toBe('allow');
    expect(perm.list).toBe('allow');
    expect(perm.codesearch).toBe('allow');
    expect(perm.ast_grep_search).toBe('allow');
    expect(perm.future_danger_tool).toBeUndefined();

    // Skills are strictly deny-all
    const skillPerm = perm.skill as Record<string, string>;
    expect(skillPerm['*']).toBe('deny');
    expect(skillPerm.custom_skill_xyz).toBeUndefined();
    expect(Object.values(skillPerm).every((value) => value === 'deny')).toBe(
      true,
    );

    // In getAgentConfigs:
    const configs = getAgentConfigs(runtimeFor(hostileConfig));
    const sdkOutcomeManager = configs.auditor;
    expect(sdkOutcomeManager).toBeDefined();
    expect(sdkOutcomeManager.mcps).toEqual([]);
    expect(sdkOutcomeManager.description).toContain(
      'Read-only outcome manager',
    );

    const sdkPerm = sdkOutcomeManager.permission as Record<string, unknown>;
    expect(sdkPerm['*']).toBe('deny');
    expect(sdkPerm.bash).toBe('deny');
    expect(sdkPerm.edit).toBe('deny');
    expect(sdkPerm.write).toBe('deny');
    expect(sdkPerm.apply_patch).toBe('deny');
    expect(sdkPerm.ast_grep_replace).toBe('deny');
    expect(sdkPerm.task).toBe('deny');
    expect(sdkPerm.question).toBe('deny');
    expect(sdkPerm.wait_for_user).toBe('deny');
    expect(sdkPerm.future_danger_tool).toBeUndefined();

    // Oracle retains its allowed overrides
    expect(configs.oracle.mcps).toEqual(['context7']);
    const oraclePerm = configs.oracle.permission as Record<string, unknown>;
    expect(oraclePerm.bash).toBe('allow');
    expect(oraclePerm.future_oracle_tool).toBe('allow');
  });

  test('ignores shorthand string permission override for outcome-manager', () => {
    const config: PluginConfig = {
      agents: {
        'outcome-manager': {
          permission: 'allow',
        },
      },
    };

    const configs = getAgentConfigs(runtimeFor(config));
    const managerConfig = configs['outcome-manager'];
    expect(typeof managerConfig.permission).toBe('object');
    const perm = managerConfig.permission as Record<string, unknown>;
    expect(perm['*']).toBe('deny');
    expect(perm.bash).toBe('deny');
    expect(perm.read).toBe('allow');
  });
});
