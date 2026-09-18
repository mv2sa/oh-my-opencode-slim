/**
 * Kernel↔host boundary for the Outcome layer.
 *
 * The outcome kernel (`OutcomeController`, its store, schema and digests) owns
 * protocol, persistence and identity only. Everything it needs from the
 * embedding host — background-job board lookups, child-session result reads,
 * manager-task consumption and agent-name resolution — arrives through this
 * port.
 *
 * Today the host adapter is `src/index.ts` (OpenCode/OMOS). A future
 * standalone plugin can supply its own adapter without touching the kernel;
 * the kernel depends only on `OutcomeHost`, never on host modules.
 */
import type {
  ChildSessionReaderResult,
  ManagerTaskVerification,
} from './controller';

export interface OutcomeHost {
  getManagerTaskRecord?: (
    taskId: string,
  ) => ManagerTaskVerification | undefined;
  readChildSessionResult?: (
    childSessionId: string,
  ) => Promise<ChildSessionReaderResult | undefined>;
  consumeManagerTask?: (
    rootSessionId: string,
    taskId: string,
    generation: number,
  ) => boolean;
  hasRunningChildren?: (rootSessionId: string) => boolean;
  hasTerminalUnreconciledChildren?: (rootSessionId: string) => boolean;
  resolveAgentName?: (agent: string) => string;
}

/**
 * Resolve the effective host from either the explicit `host` port or the
 * legacy flat option fields. Per callback, `options.host` wins and the flat
 * field is the fallback, so both option shapes keep working. Total: this never
 * validates or throws.
 */
export function resolveOutcomeHost(
  options: OutcomeHost & { host?: OutcomeHost },
): OutcomeHost {
  const host = options.host;
  return {
    getManagerTaskRecord:
      host?.getManagerTaskRecord ?? options.getManagerTaskRecord,
    readChildSessionResult:
      host?.readChildSessionResult ?? options.readChildSessionResult,
    consumeManagerTask: host?.consumeManagerTask ?? options.consumeManagerTask,
    hasRunningChildren: host?.hasRunningChildren ?? options.hasRunningChildren,
    hasTerminalUnreconciledChildren:
      host?.hasTerminalUnreconciledChildren ??
      options.hasTerminalUnreconciledChildren,
    resolveAgentName: host?.resolveAgentName ?? options.resolveAgentName,
  };
}
