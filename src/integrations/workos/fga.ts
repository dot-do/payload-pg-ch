export interface FGAConfig {
  apiKey: string
}

export async function canAccess(
  config: FGAConfig,
  userId: string,
  nsId: string,
  relation: string,
): Promise<boolean> {
  const response = await fetch('https://api.workos.com/fga/v1/check', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      checks: [{
        resource: { resourceType: 'ns', resourceId: nsId },
        relation,
        subject: { resourceType: 'user', resourceId: userId },
      }],
    }),
  })

  if (!response.ok) return false
  const data = await response.json() as { result: string }
  return data.result === 'authorized'
}

export async function canEdit(
  config: FGAConfig,
  userId: string,
  docId: string,
): Promise<boolean> {
  return canAccess(config, userId, docId, 'editor')
}

export async function syncOrgMemberships(
  config: FGAConfig,
  userId: string,
  workosOrgId: string,
): Promise<void> {
  const response = await fetch('https://api.workos.com/fga/v1/warrants', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resource: { resourceType: 'ns', resourceId: workosOrgId },
      relation: 'member',
      subject: { resourceType: 'user', resourceId: userId },
    }),
  })
  if (!response.ok) {
    throw new Error(`WorkOS syncOrgMemberships failed: ${response.status} ${await response.text()}`)
  }
}
