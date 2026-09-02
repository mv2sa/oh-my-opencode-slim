import { describe, expect, test } from 'bun:test';
import { parseOutcomeReview, safeParseOutcomeReview } from './parser';
import type { OutcomeReview } from './schema';

function makeValidAcceptReview(
  overrides?: Partial<OutcomeReview>,
): OutcomeReview {
  return {
    summary: 'All goals satisfied and verified.',
    verdict: 'ACCEPT',
    candidateFingerprint: 'sha-candidate-456',
    goals: [
      {
        id: 'g-1',
        description: 'Implement outcome manager subagent',
        status: 'satisfied',
      },
      {
        id: 'g-2',
        description: 'Implement outcome parser with strict Zod validation',
        status: 'satisfied',
      },
    ],
    scope: {
      inScope: ['src/agents/outcome-manager.ts', 'src/outcome/**'],
      outOfScope: ['Durable controller runtime', 'Terrarium dependencies'],
    },
    rules: [
      {
        id: 'rule-gov-1',
        sourcePath: 'AGENTS.md',
        category: 'governance',
        summary: 'Read-only boundary for advisory agents',
        ruleType: 'semantic',
        enforcementStatus: 'satisfied',
        evidenceIds: ['ev-1'],
      },
      {
        id: 'rule-test-1',
        sourcePath: 'docs/testing.md',
        category: 'testing',
        summary: 'Unit test coverage for new components',
        ruleType: 'machine_enforced',
        enforcementStatus: 'satisfied',
        evidenceIds: ['ev-1', 'ev-2'],
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        command: 'bun test src/agents/outcome-manager.test.ts',
        status: 'passed',
        fingerprint: 'sha-candidate-456',
        freshness: 'fresh',
        isFinalCandidate: true,
        outputSummary: 'All agent tests passed',
      },
      {
        id: 'ev-2',
        command: 'bun test src/outcome/parser.test.ts',
        status: 'passed',
        fingerprint: 'sha-candidate-456',
        freshness: 'fresh',
        isFinalCandidate: true,
        outputSummary: 'All parser tests passed',
      },
    ],
    constraintCoherence: {
      ordering: ['Security/Permissions', 'Deterministic Validation', 'Handoff'],
      coherent: true,
      conflicts: [],
    },
    exceptions: [],
    handoff: {
      ready: true,
      summary: 'Implementation complete and verified ready for merge.',
      verificationSteps: ['bun test', 'bun run typecheck'],
    },
    lifecycle: {
      stage: 'completed',
      receiptAgreement: true,
      notes: 'All receipts match evidence fingerprints',
    },
    ...overrides,
  };
}

function wrapEnvelope(data: unknown): string {
  return `<outcome_review>\n${JSON.stringify(data, null, 2)}\n</outcome_review>`;
}

describe('outcome parser - envelope extraction', () => {
  test('parses clean valid ACCEPT outcome review inside envelope', () => {
    const review = makeValidAcceptReview();
    const wrapped = wrapEnvelope(review);
    const parsed = parseOutcomeReview(wrapped);
    expect(parsed).toEqual(review);
  });

  test('parses review when surrounded by LLM preamble and commentary', () => {
    const review = makeValidAcceptReview();
    const text = `Here is my outcome review analysis:\n\n${wrapEnvelope(
      review,
    )}\n\nEnd of report.`;
    const parsed = parseOutcomeReview(text);
    expect(parsed.verdict).toBe('ACCEPT');
    expect(parsed.summary).toBe(review.summary);
  });

  test('rejects text missing <outcome_review> envelope', () => {
    expect(() => parseOutcomeReview('No envelope here')).toThrow(
      /Missing <outcome_review> envelope/,
    );
  });

  test('rejects text with multiple <outcome_review> envelopes', () => {
    const r1 = wrapEnvelope(makeValidAcceptReview());
    const r2 = wrapEnvelope(makeValidAcceptReview());
    expect(() => parseOutcomeReview(`${r1}\n${r2}`)).toThrow(
      /Multiple <outcome_review> envelopes found/,
    );
  });

  test('rejects mismatched envelope tags', () => {
    expect(() =>
      parseOutcomeReview('<outcome_review>{"verdict":"CONTINUE"}'),
    ).toThrow(/Mismatched <outcome_review> envelope tags/);
    expect(() =>
      parseOutcomeReview('{"verdict":"CONTINUE"}</outcome_review>'),
    ).toThrow(/Mismatched <outcome_review> envelope tags/);
  });

  test('rejects reversed tags', () => {
    expect(() =>
      parseOutcomeReview(
        '</outcome_review>{"verdict":"CONTINUE"}<outcome_review>',
      ),
    ).toThrow(/closing tag appears before opening tag/);
  });

  test('rejects empty envelope', () => {
    expect(() =>
      parseOutcomeReview('<outcome_review>   </outcome_review>'),
    ).toThrow(/Empty <outcome_review> envelope/);
  });

  test('rejects malformed JSON inside envelope', () => {
    expect(() =>
      parseOutcomeReview('<outcome_review>{ bad json </outcome_review>'),
    ).toThrow(/Malformed JSON inside <outcome_review> envelope/);
  });
});

describe('outcome parser - verdicts', () => {
  test('parses CONTINUE verdict with in_progress goals', () => {
    const review: OutcomeReview = {
      summary: 'Task partially complete, next step is parser test suite.',
      verdict: 'CONTINUE',
      goals: [
        { id: 'g-1', description: 'Core parser', status: 'satisfied' },
        { id: 'g-2', description: 'Parser tests', status: 'in_progress' },
      ],
      scope: { inScope: ['src/outcome/**'], outOfScope: [] },
      rules: [
        {
          id: 'r-1',
          sourcePath: 'AGENTS.md',
          category: 'governance',
          summary: 'Testing requirement',
          ruleType: 'machine_enforced',
          enforcementStatus: 'pending',
          evidenceIds: [],
        },
      ],
      evidence: [],
      constraintCoherence: {
        ordering: ['1. Implement', '2. Test'],
        coherent: true,
      },
      exceptions: [],
      handoff: {
        ready: false,
        summary: 'Not ready for handoff yet.',
        verificationSteps: ['Run parser tests when written'],
      },
      lifecycle: { stage: 'execution', receiptAgreement: true },
    };

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('CONTINUE');
  });

  test('parses CORRECT_DRIFT verdict with drifted goals or rule violations', () => {
    const review: OutcomeReview = {
      summary: 'Drift detected: modified out-of-scope files.',
      verdict: 'CORRECT_DRIFT',
      goals: [
        { id: 'g-1', description: 'Scoped change only', status: 'drifted' },
      ],
      scope: {
        inScope: ['src/agents/outcome-manager.ts'],
        outOfScope: ['src/index.ts'],
      },
      rules: [
        {
          id: 'r-scope',
          sourcePath: 'task-spec',
          category: 'governance',
          summary: 'Do not edit owned path violations',
          ruleType: 'machine_enforced',
          enforcementStatus: 'violated',
          evidenceIds: ['ev-diff'],
        },
      ],
      evidence: [
        {
          id: 'ev-diff',
          command: 'git diff',
          status: 'failed',
          fingerprint: 'sha-drift',
          freshness: 'fresh',
          isFinalCandidate: false,
        },
      ],
      constraintCoherence: {
        ordering: ['Scope boundary'],
        coherent: false,
        conflicts: ['Touched src/index.ts'],
      },
      exceptions: [],
      handoff: {
        ready: false,
        summary: 'Revert out-of-scope changes before proceeding.',
        verificationSteps: ['git checkout src/index.ts'],
      },
      lifecycle: { stage: 'review', receiptAgreement: false },
    };

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('CORRECT_DRIFT');
  });

  test('parses REVISE_CONTRACT verdict with contradictory constraints', () => {
    const review: OutcomeReview = {
      summary: 'Requested outcome contradicts architectural invariants.',
      verdict: 'REVISE_CONTRACT',
      goals: [
        {
          id: 'g-1',
          description: 'Add shell access to read-only agent',
          status: 'blocked',
          notes: 'Violates read-only invariant',
        },
      ],
      scope: { inScope: ['src/agents/outcome-manager.ts'], outOfScope: [] },
      rules: [
        {
          id: 'r-security',
          sourcePath: 'src/agents/permissions.ts',
          category: 'security',
          summary: 'Read-only agents must deny bash',
          ruleType: 'semantic',
          enforcementStatus: 'violated',
          evidenceIds: [],
        },
      ],
      evidence: [],
      constraintCoherence: {
        ordering: ['Security invariant > user feature request'],
        coherent: false,
        conflicts: ['Feature requires bash but security strictly denies bash'],
      },
      exceptions: [],
      handoff: {
        ready: false,
        summary: 'Contract revision required.',
        verificationSteps: [],
      },
      lifecycle: { stage: 'review', receiptAgreement: false },
    };

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('REVISE_CONTRACT');
  });

  test('parses USER_DECISION_REQUIRED verdict with blocking decision object and handoff.ready=false', () => {
    const review: OutcomeReview = {
      summary:
        'User input required to choose between breaking vs backward-compatible schema.',
      verdict: 'USER_DECISION_REQUIRED',
      goals: [
        { id: 'g-1', description: 'Define schema', status: 'in_progress' },
      ],
      scope: { inScope: ['src/outcome/schema.ts'], outOfScope: [] },
      rules: [],
      evidence: [],
      constraintCoherence: { ordering: [], coherent: true },
      exceptions: [],
      handoff: {
        ready: false,
        summary: 'Waiting on user decision',
        verificationSteps: [],
      },
      lifecycle: { stage: 'execution', receiptAgreement: true },
      userDecision: {
        decisionNeeded: 'Select schema migration strategy',
        options: ['Strict breaking change v2', 'Deprecate with alias v1+v2'],
        blocking: true,
        impact: 'Affects backward compatibility with legacy presets',
      },
    };

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('USER_DECISION_REQUIRED');
    expect(parsed.userDecision?.blocking).toBe(true);
  });

  test('parses ACCEPT verdict with repository waiver and user decision authorizations', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'rule-waiver-1',
          sourcePath: 'docs/performance.md',
          category: 'performance',
          summary: 'Memory budget constraint',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceIds: ['ev-1'],
        },
        {
          id: 'rule-waiver-2',
          sourcePath: 'docs/architecture.md',
          category: 'architecture',
          summary: 'Single-thread worker limit',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceIds: ['ev-1'],
        },
      ],
      exceptions: [
        {
          ruleId: 'rule-waiver-1',
          justification:
            'Repository waiver manifest approves memory spike during test run',
          justified: true,
          scope: 'Scoped to unit tests only',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'governance/waivers/perf-2026.json',
        },
        {
          ruleId: 'rule-waiver-2',
          justification:
            'User explicitly approved temporary 2-thread worker exception in session turn 3',
          justified: true,
          scope: 'Scoped to session execution',
          authorizationKind: 'user_decision',
          authorizationReference: 'user-turn-msg-8910',
        },
      ],
    });

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('ACCEPT');
    expect(parsed.exceptions.length).toBe(2);
    expect(parsed.exceptions[0].authorizationKind).toBe('repository_waiver');
    expect(parsed.exceptions[1].authorizationKind).toBe('user_decision');
  });

  test('parses ACCEPT verdict with multiple same-fingerprint final receipts plus older non-final historical evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final-head',
      evidence: [
        {
          id: 'ev-historical-1',
          command: 'bun test intermediate.test.ts',
          status: 'passed',
          fingerprint: 'sha-old-123',
          freshness: 'stale',
          isFinalCandidate: false,
          outputSummary: 'Old intermediate test run',
        },
        {
          id: 'ev-final-1',
          command: 'bun test suite-1.test.ts',
          status: 'passed',
          fingerprint: 'sha-final-head',
          freshness: 'fresh',
          isFinalCandidate: true,
          outputSummary: 'Suite 1 passed on final candidate',
        },
        {
          id: 'ev-final-2',
          command: 'bun test suite-2.test.ts',
          status: 'passed',
          fingerprint: 'sha-final-head',
          freshness: 'fresh',
          isFinalCandidate: true,
          outputSummary: 'Suite 2 passed on final candidate',
        },
      ],
      rules: [
        {
          id: 'rule-1',
          sourcePath: 'testing.md',
          category: 'testing',
          summary: 'Testing requirement',
          ruleType: 'machine_enforced',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-final-1', 'ev-final-2'],
        },
      ],
    });

    const parsed = parseOutcomeReview(wrapEnvelope(review));
    expect(parsed.verdict).toBe('ACCEPT');
    expect(parsed.evidence.length).toBe(3);
  });
});

describe('outcome parser - schema and semantic rejection invariants', () => {
  test('rejects unknown verdict', () => {
    const review = makeValidAcceptReview();
    (review as any).verdict = 'MAYBE_ACCEPT';
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Outcome review validation failed/,
    );
  });

  test('rejects unknown top-level fields (strict schema)', () => {
    const review = makeValidAcceptReview();
    (review as any).unexpectedField = 'surprise';
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Outcome review validation failed/,
    );
  });

  test('rejects duplicate goal IDs', () => {
    const review = makeValidAcceptReview({
      goals: [
        { id: 'duplicate-id', description: 'Goal 1', status: 'satisfied' },
        { id: 'duplicate-id', description: 'Goal 2', status: 'satisfied' },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Duplicate goal ID 'duplicate-id'/,
    );
  });

  test('rejects duplicate rule IDs', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'dup-rule',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Rule A',
          ruleType: 'semantic',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-1'],
        },
        {
          id: 'dup-rule',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Rule B',
          ruleType: 'semantic',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-1'],
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Duplicate rule ID 'dup-rule'/,
    );
  });

  test('rejects duplicate evidence IDs', () => {
    const review = makeValidAcceptReview({
      evidence: [
        {
          id: 'dup-ev',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-candidate-456',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
        {
          id: 'dup-ev',
          command: 'bun run typecheck',
          status: 'passed',
          fingerprint: 'sha-candidate-456',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Duplicate evidence ID 'dup-ev'/,
    );
  });

  test('rejects empty required strings', () => {
    const review = makeValidAcceptReview();
    review.summary = '   ';
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Outcome review validation failed/,
    );
  });

  test('rejects references to undeclared evidence IDs', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-1',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Gov rule',
          ruleType: 'semantic',
          enforcementStatus: 'satisfied',
          evidenceIds: ['non-existent-evidence-id'],
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Rule 'r-1' references undeclared evidence ID 'non-existent-evidence-id'/,
    );
  });

  test('rejects references to undeclared rule IDs in exceptions', () => {
    const review = makeValidAcceptReview({
      exceptions: [
        {
          ruleId: 'ghost-rule-id',
          justification: 'Waiver',
          justified: true,
          scope: 'Global',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'ref-1',
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Exception references undeclared rule ID 'ghost-rule-id'/,
    );
  });

  test('rejects exceptions referencing non-waived rules (satisfied/pending/violated/not_applicable)', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-satisfied',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Satisfied rule',
          ruleType: 'semantic',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-1'],
        },
      ],
      exceptions: [
        {
          ruleId: 'r-satisfied',
          justification: 'Unneeded exception',
          justified: true,
          scope: 'Global',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'ref-1',
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Rule 'r-satisfied' has status 'satisfied' and must not have an exception/,
    );
  });

  test('rejects duplicate exceptions for the same rule ID', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-waived',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Waived rule',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceIds: ['ev-1'],
        },
      ],
      exceptions: [
        {
          ruleId: 'r-waived',
          justification: 'Exception 1',
          justified: true,
          scope: 'Scope 1',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'ref-1',
        },
        {
          ruleId: 'r-waived',
          justification: 'Exception 2',
          justified: true,
          scope: 'Scope 2',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'ref-2',
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Duplicate exception for rule ID 'r-waived'/,
    );
  });

  test('rejects waived rule without an exception', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-waived',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Waived rule',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceIds: ['ev-1'],
        },
      ],
      exceptions: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Waived rule 'r-waived' must have an exception/,
    );
  });

  test('rejects userDecision present on verdicts other than USER_DECISION_REQUIRED', () => {
    for (const verdict of [
      'ACCEPT',
      'CONTINUE',
      'CORRECT_DRIFT',
      'REVISE_CONTRACT',
    ] as const) {
      const review: any = makeValidAcceptReview({
        verdict,
        userDecision: {
          decisionNeeded: 'Choice',
          options: ['A', 'B'],
          blocking: true,
        },
      });
      expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
        new RegExp(`userDecision must be absent for verdict '${verdict}'`),
      );
    }
  });

  test('rejects USER_DECISION_REQUIRED without userDecision object', () => {
    const review = makeValidAcceptReview({
      verdict: 'USER_DECISION_REQUIRED',
      userDecision: undefined,
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Verdict USER_DECISION_REQUIRED requires userDecision object/,
    );
  });

  test('rejects USER_DECISION_REQUIRED with blocking=false', () => {
    const review = makeValidAcceptReview({
      verdict: 'USER_DECISION_REQUIRED',
      handoff: { ready: false, summary: 'Pending', verificationSteps: [] },
      userDecision: {
        decisionNeeded: 'Color theme choice',
        options: ['dark', 'light'],
        blocking: false,
      },
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /requires userDecision.blocking to be true/,
    );
  });

  test('rejects USER_DECISION_REQUIRED with handoff.ready=true', () => {
    const review = makeValidAcceptReview({
      verdict: 'USER_DECISION_REQUIRED',
      handoff: {
        ready: true,
        summary: 'Prematurely ready',
        verificationSteps: ['step'],
      },
      userDecision: {
        decisionNeeded: 'Blocking question',
        options: ['A', 'B'],
        blocking: true,
      },
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Verdict USER_DECISION_REQUIRED requires handoff.ready to be false/,
    );
  });

  test('rejects ACCEPT without candidateFingerprint', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: undefined,
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Verdict ACCEPT requires candidateFingerprint/,
    );
  });

  test('rejects ACCEPT when goal status is not satisfied (in_progress, blocked, drifted, unmet)', () => {
    for (const status of [
      'in_progress',
      'blocked',
      'drifted',
      'unmet',
    ] as const) {
      const review = makeValidAcceptReview({
        goals: [
          { id: 'g-1', description: 'Goal 1', status: 'satisfied' },
          { id: 'g-2', description: 'Goal 2', status },
        ],
      });
      expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
        new RegExp(`Cannot ACCEPT when goal 'g-2' has status '${status}'`),
      );
    }
  });

  test('rejects ACCEPT with violated rule', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-violated',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Strict rule',
          ruleType: 'semantic',
          enforcementStatus: 'violated',
          evidenceIds: ['ev-1'],
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT when rule 'r-violated' is violated/,
    );
  });

  test('rejects ACCEPT with pending rule', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-pending',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Pending check',
          ruleType: 'semantic',
          enforcementStatus: 'pending',
          evidenceIds: [],
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT when rule 'r-pending' enforcement is pending/,
    );
  });

  test('rejects ACCEPT when machine-enforced rule is backed only by stale evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      rules: [
        {
          id: 'r-machine',
          sourcePath: 'tests.ts',
          category: 'testing',
          summary: 'Machine test',
          ruleType: 'machine_enforced',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-stale'],
        },
      ],
      evidence: [
        {
          id: 'ev-stale',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'stale',
          isFinalCandidate: false,
        },
        {
          id: 'ev-final-unrelated',
          command: 'bun run typecheck',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Satisfied machine-enforced rule 'r-machine' must reference at least one fresh passed final-candidate evidence receipt/,
    );
  });

  test('rejects ACCEPT when machine-enforced rule is backed only by non-final evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      rules: [
        {
          id: 'r-machine',
          sourcePath: 'tests.ts',
          category: 'testing',
          summary: 'Machine test',
          ruleType: 'machine_enforced',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-non-final'],
        },
      ],
      evidence: [
        {
          id: 'ev-non-final',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: false, // not final candidate
        },
        {
          id: 'ev-final-unrelated',
          command: 'bun run typecheck',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Satisfied machine-enforced rule 'r-machine' must reference at least one fresh passed final-candidate evidence receipt/,
    );
  });

  test('rejects ACCEPT when machine-enforced rule is backed only by fingerprint-mismatched evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      rules: [
        {
          id: 'r-machine',
          sourcePath: 'tests.ts',
          category: 'testing',
          summary: 'Machine test',
          ruleType: 'machine_enforced',
          enforcementStatus: 'satisfied',
          evidenceIds: ['ev-old-sha'],
        },
      ],
      evidence: [
        {
          id: 'ev-old-sha',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-older-commit',
          freshness: 'fresh',
          isFinalCandidate: false,
        },
        {
          id: 'ev-final-unrelated',
          command: 'bun run typecheck',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Satisfied machine-enforced rule 'r-machine' must reference at least one fresh passed final-candidate evidence receipt/,
    );
  });

  test('rejects ACCEPT with unjustified exception', () => {
    const review = makeValidAcceptReview({
      rules: [
        {
          id: 'r-waived',
          sourcePath: 'AGENTS.md',
          category: 'gov',
          summary: 'Waived rule',
          ruleType: 'semantic',
          enforcementStatus: 'waived',
          evidenceIds: ['ev-1'],
        },
      ],
      exceptions: [
        {
          ruleId: 'r-waived',
          justification: 'Not justified reason',
          justified: false,
          scope: 'Global',
          authorizationKind: 'repository_waiver',
          authorizationReference: 'waiver.json',
        },
      ],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT with unjustified exception for rule 'r-waived'/,
    );
  });

  test('rejects ACCEPT with empty evidence array', () => {
    const review = makeValidAcceptReview({
      evidence: [],
      rules: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT without evidence receipts/,
    );
  });

  test('rejects ACCEPT without fresh final-candidate passed evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      evidence: [
        {
          id: 'ev-1',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'stale',
          isFinalCandidate: true,
        },
      ],
      rules: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Final candidate evidence 'ev-1' freshness 'stale' must be 'fresh'/,
    );
  });

  test('rejects ACCEPT when final candidate evidence fingerprint mismatches candidateFingerprint', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-expected',
      evidence: [
        {
          id: 'ev-1',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-different',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
      ],
      rules: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Final candidate evidence 'ev-1' fingerprint 'sha-different' does not match candidateFingerprint 'sha-expected'/,
    );
  });

  test('rejects ACCEPT with pending evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      evidence: [
        {
          id: 'ev-1',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
        {
          id: 'ev-pending',
          command: 'bun run typecheck',
          status: 'pending',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: false,
        },
      ],
      rules: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT with pending evidence 'ev-pending'/,
    );
  });

  test('rejects ACCEPT with failed evidence', () => {
    const review = makeValidAcceptReview({
      candidateFingerprint: 'sha-final',
      evidence: [
        {
          id: 'ev-1',
          command: 'bun test',
          status: 'passed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: true,
        },
        {
          id: 'ev-failed',
          command: 'bun run typecheck',
          status: 'failed',
          fingerprint: 'sha-final',
          freshness: 'fresh',
          isFinalCandidate: false,
        },
      ],
      rules: [],
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT with failed evidence 'ev-failed'/,
    );
  });

  test('rejects ACCEPT when lifecycle.stage is not completed (execution, review, abandoned)', () => {
    for (const stage of ['execution', 'review', 'abandoned'] as const) {
      const review = makeValidAcceptReview({
        lifecycle: {
          stage,
          receiptAgreement: true,
        },
      });
      expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
        new RegExp(`Cannot ACCEPT when lifecycle.stage is '${stage}'`),
      );
    }
  });

  test('rejects ACCEPT when handoff has empty verificationSteps', () => {
    const review = makeValidAcceptReview({
      handoff: {
        ready: true,
        summary: 'Done',
        verificationSteps: [],
      },
    });
    expect(() => parseOutcomeReview(wrapEnvelope(review))).toThrow(
      /Cannot ACCEPT when handoff.verificationSteps has no verification steps/,
    );
  });
});

describe('safeParseOutcomeReview', () => {
  test('returns success: true and data on valid review', () => {
    const review = makeValidAcceptReview();
    const result = safeParseOutcomeReview(wrapEnvelope(review));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe('ACCEPT');
    }
  });

  test('returns success: false and error string on invalid review', () => {
    const result = safeParseOutcomeReview('invalid string');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing <outcome_review> envelope');
    }
  });
});
