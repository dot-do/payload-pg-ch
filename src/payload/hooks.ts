import type { NsRow } from '../types.js'
import type { NsResolver } from '../ns/resolver.js'

export interface HookContext {
  req: { headers: { host?: string }; url?: string }
  ns?: NsRow
  actor?: number
}

export function createNsHook(nsResolver: NsResolver) {
  return async (ctx: HookContext): Promise<HookContext> => {
    const ns = nsResolver.resolveFromRequest(ctx.req)
    return { ...ctx, ns: ns ?? undefined }
  }
}

export function createActorHook() {
  return async (ctx: HookContext & { user?: { id: number } }): Promise<HookContext> => {
    return { ...ctx, actor: ctx.user?.id }
  }
}
