/**
 * v1 PluginInput shim (real delegation).
 *
 * The v1 plugin factory expects a `PluginInput` with an HTTP `client`,
 * project metadata, and a shell. v2's plugin context exposes none of these,
 * so this shim builds a v1-shaped input whose `client` translates the v1
 * SDK call shapes (Hono-style `{path, body}` or flat `{sessionID}`) into
 * v2 flat session calls (`get`/`interrupt`/`switchModel`/`prompt`/
 * `context`). Delegation is real where the v2 host provides the method and
 * explicitly fails or degrades with a log where it does not — the shim
 * never fakes success shapes.
 *
 * The v2 model-switch semantics (prompts carry no model; `switchModel`
 * must precede the prompt) are encapsulated in the `promptAsync`
 * translation, which is what lets the v1 foreground-fallback pipeline work
 * unmodified on v2.
 */

import { log } from '../utils/logger';
import type { V2Context } from './types';

/** v2 model reference accepted by `ctx.generate.text`. */
export interface V2GenerateModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** Optional v2 capabilities threaded into the v1 PluginInput. Absent
 * capabilities must leave the input object unchanged (v1 parity). */
export interface ExperimentalV2 {
  /** One-shot generation (`ctx.generate.text`); no session involved. */
  generateText?: (
    prompt: string,
    model?: V2GenerateModelRef,
  ) => Promise<{ text: string }>;
}

/** Directory from the host-reported location; cwd on hosts without
 * `ctx.location` (or with an empty directory). */
export function resolveV2Directory(ctx: V2Context): string {
  const directory = ctx.location?.directory;
  return typeof directory === 'string' && directory ? directory : process.cwd();
}

/** Accept both Hono-style ({path:{id}}) and flat ({sessionID}) calls. */
function sessionIDOf(args: Record<string, unknown>): string {
  return (
    (args?.path as { id?: string } | undefined)?.id ??
    (args?.sessionID as string | undefined) ??
    ''
  );
}

/** Join the text parts of a v1 prompt body into v2 prompt text. */
function textFromBody(args: Record<string, unknown>): string {
  const body = (args?.body ?? {}) as {
    parts?: Array<{ type?: string; text?: string }>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

/** Map non-text v1 prompt parts (images, files) into v2 prompt `files`
 * entries. The fallback replay must not silently drop attachments: v1's
 * prompt API carries parts natively, so a text-only translation would
 * resend an attachment-dependent request without its content. Parts whose
 * uri cannot be derived are logged and skipped (honest degradation). */
function filesFromBody(
  args: Record<string, unknown>,
): Array<{ uri: string; name?: string }> {
  const body = (args?.body ?? {}) as {
    parts?: Array<Record<string, unknown>>;
  };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const files: Array<{ uri: string; name?: string }> = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') continue;
    const uri = [p.uri, p.url].find((v) => typeof v === 'string' && v) as
      | string
      | undefined;
    if (!uri) {
      log('[v2][shim] non-text prompt part without uri dropped', {
        type: typeof p.type === 'string' ? p.type : 'unknown',
      });
      continue;
    }
    const name =
      (p.filename as string | undefined) ?? (p.name as string | undefined);
    files.push({ uri, ...(name ? { name } : {}) });
  }
  return files;
}

/** v2 transcript message (content parts) → v1 SDK message view
 * (`{info: {id, role}, parts}`) expected by the v1 pipeline. */
function toV1Message(m: Record<string, unknown>) {
  return {
    info: { id: m.id, role: m.role ?? m.type },
    parts: Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((p) => ({ ...p }))
      : [],
  };
}

/** v1 body model (`{providerID, modelID}`) → v2 model ref
 * (`{id, providerID}`). */
function modelRefFromBody(body: {
  model?: { id?: string; modelID?: string; providerID?: string };
}): { id: string; providerID: string } | undefined {
  const model = body.model;
  if (!model) return undefined;
  const id = model.id ?? model.modelID ?? '';
  const providerID = model.providerID ?? '';
  return id && providerID ? { id, providerID } : undefined;
}

/** Build a v1-compatible PluginInput from the v2 context. The optional
 * `extras` threads probed v2 capabilities (e.g. one-shot generation)
 * through as `experimental_v2`; when absent no `experimental_v2` key is
 * added so the v1 pipeline stays byte-identical. */
export function buildPluginInput(
  ctx: V2Context,
  extras?: ExperimentalV2,
): Record<string, unknown> {
  // Null-safe: reduced hosts may load the factory without a session domain;
  // every method then degrades honestly instead of crashing construction.
  const s = (ctx.session ?? {}) as V2Context['session'];
  const client = {
    session: {
      // `get` is exposed only when the host provides session.get — callers
      // like task-result probe method presence as the capability signal,
      // so a degraded stub here would fake verification ability.
      ...(s.get
        ? {
            get: async (args: Record<string, unknown>) => ({
              data: await s.get?.({ sessionID: sessionIDOf(args) }),
            }),
          }
        : {}),
      abort: s.interrupt
        ? async (args: Record<string, unknown>) =>
            s.interrupt?.({ sessionID: sessionIDOf(args), continue: false })
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.interrupt unavailable', {
              id: sessionIDOf(args),
            });
          },
      messages: s.context
        ? async (args: Record<string, unknown>) => ({
            data: (
              (await s.context?.({ sessionID: sessionIDOf(args) })) ?? []
            ).map(toV1Message),
          })
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.context unavailable', {
              id: sessionIDOf(args),
            });
            return { data: [] };
          },
      // `status` is intentionally OMITTED: v2 has no equivalent of the v1
      // live session-status map, and a stub returning `{data: {}}` would be
      // an empty-but-valid map. getRuntimeSessionStatusSnapshot treats
      // "status is a function" as the capability signal, so the stub let
      // stop-confirmation mark still-running background jobs `stopped`
      // after the grace (false terminalization). With the method absent,
      // the lookup throws → snapshot.error → the reconciler's safe
      // markStatusUncertain branch.
      list: async () => ({ data: [] }),
      prompt: s.prompt
        ? async (args: Record<string, unknown>) => {
            const files = filesFromBody(args);
            return s.prompt?.({
              sessionID: sessionIDOf(args),
              text: textFromBody(args),
              delivery: 'steer',
              ...(files.length > 0 ? { files } : {}),
            });
          }
        : async () => {
            throw new Error('[v2] session.prompt unavailable');
          },
      promptAsync: async (args: Record<string, unknown>) => {
        if (!s.prompt) {
          throw new Error('[v2] session.prompt unavailable for promptAsync');
        }
        const body = (args?.body ?? {}) as Parameters<
          typeof modelRefFromBody
        >[0] & { parts?: Array<{ type?: string; text?: string }> };
        const ref = modelRefFromBody(body);
        if (ref) {
          if (s.switchModel) {
            await s.switchModel({ sessionID: sessionIDOf(args), model: ref });
          } else {
            log(
              '[v2][shim] session.switchModel unavailable; steering on the current model',
              { id: sessionIDOf(args) },
            );
          }
        }
        const files = filesFromBody(args);
        return s.prompt({
          sessionID: sessionIDOf(args),
          text: textFromBody(args),
          delivery: 'steer',
          ...(files.length > 0 ? { files } : {}),
        });
      },
      update: s.rename
        ? async (args: Record<string, unknown>) => {
            const body = (args?.body ?? {}) as { title?: string };
            return s.rename?.({
              sessionID: sessionIDOf(args),
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
            });
          }
        : async (args: Record<string, unknown>) => {
            log('[v2][shim] session.rename unavailable', {
              id: sessionIDOf(args),
            });
          },
      delete: async (args: Record<string, unknown>) => {
        log('[v2][shim] session.delete unavailable (v2 has no delete)', {
          id: sessionIDOf(args),
        });
      },
    },
    app: {
      log: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as
          | { level?: string; message?: string }
          | undefined;
        const level = body?.level ?? 'info';
        log(`[v2][host-log] ${level}: ${body?.message ?? ''}`);
      },
    },
    tui: {
      showToast: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as { message?: string } | undefined;
        log('[v2][shim] tui.showToast (no-op on v2)', {
          message: body?.message,
        });
      },
    },
    // Misc methods the plugin may touch; all graceful no-ops.
    model: { list: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: [] }) },
  };

  const directory = resolveV2Directory(ctx);
  return {
    client,
    hostFlavor: 'v2',
    project: {
      id: ctx.location?.project?.id ?? 'global',
      directory,
    },
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    $: typeof Bun !== 'undefined' ? Bun.$ : undefined,
    ...(extras?.generateText
      ? { experimental_v2: { generateText: extras.generateText } }
      : {}),
  };
}
