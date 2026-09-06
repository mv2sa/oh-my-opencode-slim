import { describe, expect, it } from 'bun:test';
import { InterviewConfigSchema, PluginConfigSchema } from './schema';

describe('PluginConfigSchema image_routing', () => {
  it('accepts image_routing: direct with observer disabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'direct',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer enabled', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: [],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('accepts image_routing: auto with observer disabled until layers merge', () => {
    const result = PluginConfigSchema.safeParse({
      disabled_agents: ['observer'],
      image_routing: 'auto',
    });
    expect(result.success).toBe(true);
  });

  it('leaves image_routing undefined when omitted (default applied downstream)', () => {
    const result = PluginConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.image_routing).toBeUndefined();
    }
  });

  it('accepts image_routing: auto when disabled_agents is omitted', () => {
    const result = PluginConfigSchema.safeParse({ image_routing: 'auto' });
    expect(result.success).toBe(true);
  });
});

describe('PluginConfigSchema webfetch', () => {
  it('defaults the enhanced webfetch tool to enabled', () => {
    const result = PluginConfigSchema.safeParse({ webfetch: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webfetch?.enabled).toBe(true);
    }
  });

  it('accepts dedicated model fallback entries with variants', () => {
    const result = PluginConfigSchema.safeParse({
      webfetch: {
        model: [
          'openai/gpt-4o-mini',
          { id: 'anthropic/claude-3-haiku', variant: 'low-latency' },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('InterviewConfigSchema outputFolder', () => {
  it('accepts relative output folders', () => {
    expect(
      InterviewConfigSchema.safeParse({ outputFolder: 'interviews/specs' })
        .success,
    ).toBe(true);
    expect(
      InterviewConfigSchema.safeParse({
        outputFolder: String.raw`interviews\specs`,
      }).success,
    ).toBe(true);
  });

  it('rejects absolute and parent-directory output folders', () => {
    const invalidOutputFolders = [
      '/tmp/interviews',
      String.raw`\tmp\interviews`,
      'C:/tmp/interviews',
      String.raw`C:\tmp\interviews`,
      '..',
      '../interviews',
      String.raw`..\interviews`,
      'interviews/../outside',
      String.raw`interviews\..\outside`,
    ];

    for (const outputFolder of invalidOutputFolders) {
      expect(InterviewConfigSchema.safeParse({ outputFolder }).success).toBe(
        false,
      );
      expect(
        PluginConfigSchema.safeParse({ interview: { outputFolder } }).success,
      ).toBe(false);
    }
  });

  it('rejects whitespace-wrapped parent-directory output folders', () => {
    const invalidOutputFolders = [' ../outside ', String.raw` ..\outside `];

    for (const outputFolder of invalidOutputFolders) {
      expect(InterviewConfigSchema.safeParse({ outputFolder }).success).toBe(
        false,
      );
      expect(
        PluginConfigSchema.safeParse({ interview: { outputFolder } }).success,
      ).toBe(false);
    }
  });

  it('stores the trimmed output folder', () => {
    const outputFolder = '  interviews/specs  ';
    const interviewResult = InterviewConfigSchema.safeParse({ outputFolder });
    const pluginResult = PluginConfigSchema.safeParse({
      interview: { outputFolder },
    });

    expect(interviewResult.success).toBe(true);
    expect(pluginResult.success).toBe(true);
    if (interviewResult.success) {
      expect(interviewResult.data.outputFolder).toBe('interviews/specs');
    }
    if (pluginResult.success) {
      expect(pluginResult.data.interview?.outputFolder).toBe(
        'interviews/specs',
      );
    }
  });
});

describe('PluginConfigSchema backgroundJobs', () => {
  it('defaults board injection to the legacy latest strategy', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.strategy).toBe('latest');
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(20);
    }
  });

  it('defaults orchestratorWake to enabled with a 5-minute interval', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: true,
        intervalMs: 300_000,
      });
    }
  });

  it('accepts explicit orchestratorWake overrides', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        orchestratorWake: { enabled: false, intervalMs: 120_000 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.orchestratorWake).toEqual({
        enabled: false,
        intervalMs: 120_000,
      });
    }
  });

  it('rejects orchestratorWake.intervalMs below 60_000 including 0', () => {
    for (const intervalMs of [0, 1, 59_999, 60_000.5, -1]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { orchestratorWake: { intervalMs } },
        }).success,
      ).toBe(false);
    }
  });

  it('accepts orchestratorWake.intervalMs bounds', () => {
    for (const intervalMs of [60_000, 300_000, 2_147_483_647]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { orchestratorWake: { intervalMs } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.orchestratorWake?.intervalMs).toBe(
          intervalMs,
        );
      }
    }
  });

  it('accepts checkpoint-compatible board injection', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { strategy: 'checkpoint-compatible' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a bounded checkpoint snapshot retention limit', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: { maxRetainedSnapshots: 3 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.maxRetainedSnapshots).toBe(3);
    }
  });

  it('rejects checkpoint snapshot retention limits outside 1–100', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 0 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 101 },
      }).success,
    ).toBe(false);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: { maxRetainedSnapshots: 20.5 },
      }).success,
    ).toBe(false);
  });

  it('defaults the wall-clock supervisor to disabled with a 10 second grace', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.wallClockTimeoutMs).toBe(0);
      expect(result.data.backgroundJobs?.abortGraceMs).toBe(10_000);
      expect(result.data.backgroundJobs?.stopConfirmationMs).toBe(30_000);
    }
  });

  it('accepts bounded stop-confirmation intervals', () => {
    for (const stopConfirmationMs of [5_000, 30_000, 300_000]) {
      const result = PluginConfigSchema.safeParse({
        backgroundJobs: { stopConfirmationMs },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.backgroundJobs?.stopConfirmationMs).toBe(
          stopConfirmationMs,
        );
      }
    }
  });

  it('rejects invalid stop-confirmation intervals', () => {
    for (const stopConfirmationMs of [0, 4_999, 300_001, 5_000.5]) {
      expect(
        PluginConfigSchema.safeParse({
          backgroundJobs: { stopConfirmationMs },
        }).success,
      ).toBe(false);
    }
  });

  it('defaults background task concurrency limits to disabled', () => {
    const result = PluginConfigSchema.safeParse({ backgroundJobs: {} });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backgroundJobs?.concurrency).toEqual({
        defaultConcurrency: 0,
        providerConcurrency: {},
        modelConcurrency: {},
      });
    }
  });

  it('accepts default, provider, and model concurrency limits', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        concurrency: {
          defaultConcurrency: 2,
          providerConcurrency: { openai: 3 },
          modelConcurrency: { 'openai/gpt-5.6-luna': 1 },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid background task concurrency limits', () => {
    for (const concurrency of [
      { defaultConcurrency: -1 },
      { defaultConcurrency: 1001 },
      { defaultConcurrency: 1.5 },
      { providerConcurrency: { openai: -1 } },
      { providerConcurrency: { openai: 1.5 } },
      { modelConcurrency: { 'openai/gpt-5.6-luna': -1 } },
      { modelConcurrency: { 'openai/gpt-5.6-luna': 1.5 } },
    ]) {
      expect(
        PluginConfigSchema.safeParse({ backgroundJobs: { concurrency } })
          .success,
      ).toBe(false);
    }
  });

  it('accepts zero as unlimited for provider and model caps', () => {
    const result = PluginConfigSchema.safeParse({
      backgroundJobs: {
        concurrency: {
          defaultConcurrency: 2,
          providerConcurrency: { openai: 0 },
          modelConcurrency: { 'openai/gpt-5.6-luna': 0 },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        result.data.backgroundJobs?.concurrency?.providerConcurrency,
      ).toEqual({ openai: 0 });
      expect(result.data.backgroundJobs?.concurrency?.modelConcurrency).toEqual(
        { 'openai/gpt-5.6-luna': 0 },
      );
    }
  });

  it('accepts the documented wall-clock supervisor bounds', () => {
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 0,
          abortGraceMs: 1_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 60_000,
          abortGraceMs: 60_000,
        },
      }).success,
    ).toBe(true);
    expect(
      PluginConfigSchema.safeParse({
        backgroundJobs: {
          wallClockTimeoutMs: 2_147_483_647,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects wall-clock supervisor values outside the safe integer bounds', () => {
    const invalid = [
      { wallClockTimeoutMs: -1 },
      { wallClockTimeoutMs: 1 },
      { wallClockTimeoutMs: 59_999 },
      { wallClockTimeoutMs: 2_147_483_648 },
      { wallClockTimeoutMs: 60_000.5 },
      { abortGraceMs: 999 },
      { abortGraceMs: 60_001 },
      { abortGraceMs: 1_000.5 },
    ];

    for (const backgroundJobs of invalid) {
      expect(PluginConfigSchema.safeParse({ backgroundJobs }).success).toBe(
        false,
      );
    }
  });
});
