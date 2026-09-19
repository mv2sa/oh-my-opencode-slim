/**
 * Plugin init health-check thresholds and helpers.
 *
 * Deliberately NOT re-exported from the package root (`src/index.ts`).
 * OpenCode's legacy plugin loader iterates every named export of the
 * root module and invokes each as a plugin factory with `PluginInput`.
 * A helper like `minimumExpectedToolCount` would then be called with a
 * `PluginInput` object instead of `string[]`, and its numeric return
 * value would be pushed into the hooks array as if it were a `Hooks`
 * object. Keeping this module internal (imported by, but not
 * re-exported from, `src/index.ts`) avoids that class of bug entirely;
 * see https://github.com/alvinunreal/oh-my-opencode-slim/issues/894.
 */

/** Minimum expected registrations for a healthy plugin load. */
export const HEALTH_CHECK = {
  minAgents: 5,
  // Default tool set when council and ACP agents are not configured:
  // task_cancel, task_message, task_revive, task_status, task_result,
  // wait_for_user, outcome_control, webfetch, ast_grep_search,
  // ast_grep_replace.
  minTools: 10,
  minMcps: 1,
} as const;

const BASELINE_TOOL_NAMES = new Set([
  'task_cancel',
  'task_message',
  'task_revive',
  'task_status',
  'task_result',
  'wait_for_user',
  'outcome_control',
  'webfetch',
  'ast_grep_search',
  'ast_grep_replace',
]);

/**
 * Compute the minimum tool count the health check should expect, accounting
 * for baseline tools the user has intentionally disabled.
 *
 * @param disabledTools - Tool names disabled via config; non-array/malformed
 *   values (which should never occur post-validation, but are not trusted at
 *   runtime) are treated as "nothing disabled".
 * @param webfetchEnabled - Whether the enhanced webfetch tool is registered.
 * @param outcomeManagementEnabled - Whether the outcome-management layer is wired (it
 *   registers `outcome_control`). When false the tool is not registered, so the
 *   threshold drops by one; guarded against double-subtracting when the tool is also
 *   explicitly disabled.
 * @returns The adjusted minimum expected tool count
 */
export function minimumExpectedToolCount(
  disabledTools: readonly string[] = [],
  webfetchEnabled = true,
  outcomeManagementEnabled = true,
): number {
  // Config values come from user-edited JSON/JSONC (and can be re-derived
  // via runtime preset switches); never trust the declared type at
  // runtime. Fall back to "no disabled tools" instead of crashing plugin
  // init if this isn't actually an array.
  const safeDisabledTools = Array.isArray(disabledTools) ? disabledTools : [];
  const disabledBaselineTools = new Set(
    safeDisabledTools.filter(
      (toolName) =>
        BASELINE_TOOL_NAMES.has(toolName) &&
        (toolName !== 'webfetch' || webfetchEnabled),
    ),
  );
  const webfetchAdjustment = webfetchEnabled ? 0 : 1;
  // `outcome_control` is a baseline tool only while the outcome-management layer
  // is wired. When the layer is disabled the tool is never registered, so the
  // threshold must drop with it; otherwise every startup warns that registrations
  // are "suspiciously low" and misattributes the shortfall to a dependency failure.
  // Guarded so an explicit disable of the tool cannot subtract twice.
  const outcomeAdjustment =
    outcomeManagementEnabled || disabledBaselineTools.has('outcome_control')
      ? 0
      : 1;
  return (
    HEALTH_CHECK.minTools -
    webfetchAdjustment -
    disabledBaselineTools.size -
    outcomeAdjustment
  );
}
