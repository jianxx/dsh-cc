/**
 * `web` checks for `/doctor`: seam presence, the fetch-provider known limit,
 * and the haiku summarizer lane.
 * @module @jianxx/dsh-cc-command-doctor/checks/web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AliasInspection, ModelRoutesSeam } from './models.ts'
import type { Check } from '../report.ts'

/** Collect the web group checks. */
export function webChecks(ctx: Context): Check[] {
  const checks: Check[] = []
  const web = ctx.get('web') as { fetch?: unknown } | undefined
  if (web === undefined) {
    checks.push({
      id: 'web.seam',
      group: 'web',
      status: 'skip',
      summary: 'web seam not mounted',
    })
  } else {
    checks.push({
      id: 'web.seam',
      group: 'web',
      status: 'ok',
      summary: 'web seam mounted',
    })
    checks.push(typeof web.fetch === 'function'
      ? { id: 'web.fetch-provider', group: 'web', status: 'ok', summary: 'fetch provider mounted' }
      : {
          id: 'web.fetch-provider',
          group: 'web',
          status: 'info',
          summary: 'fetch provider not mounted (WEB_PROVIDER_UNAVAILABLE at execute; known limit)',
        })
  }
  checks.push(haikuSummarizerCheck(ctx))
  return checks
}

/** The haiku cheap lane: a full route is ok, inherit is info. */
function haikuSummarizerCheck(ctx: Context): Check {
  const routes = ctx.get('ccModelRoutes') as ModelRoutesSeam | undefined
  if (routes?.inspect === undefined) {
    return {
      id: 'web.haiku-summarizer',
      group: 'web',
      status: 'skip',
      summary: 'ccModelRoutes not mounted',
    }
  }
  const inspection: AliasInspection = routes.inspect('haiku')
  const route = inspection.route
  if (inspection.kind !== 'inherit' && route?.provider !== undefined && route.model !== undefined) {
    return {
      id: 'web.haiku-summarizer',
      group: 'web',
      status: 'ok',
      summary: `haiku summarizer: ${route.provider}/${route.model}`,
      evidence: { provider: route.provider, model: route.model },
    }
  }
  return {
    id: 'web.haiku-summarizer',
    group: 'web',
    status: 'info',
    summary: 'haiku inherit (titles / WebFetch prompt / hooks inherit)',
  }
}
