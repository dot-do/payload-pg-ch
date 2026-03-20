export interface VaultConfig {
  apiKey: string
}

export async function storeSecret(
  config: VaultConfig,
  name: string,
  value: string,
  environment: string = 'production',
): Promise<void> {
  const response = await fetch('https://api.workos.com/vault/v1/secrets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, value, environment }),
  })
  if (!response.ok) {
    throw new Error(`WorkOS storeSecret failed: ${response.status} ${await response.text()}`)
  }
}

export async function getSecret(
  config: VaultConfig,
  name: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.workos.com/vault/v1/secrets/${encodeURIComponent(name)}`,
    {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    },
  )
  if (!response.ok) return null
  const data = await response.json() as { value: string }
  return data.value
}

export async function deleteSecret(
  config: VaultConfig,
  name: string,
): Promise<void> {
  const response = await fetch(
    `https://api.workos.com/vault/v1/secrets/${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    },
  )
  if (!response.ok) {
    throw new Error(`WorkOS deleteSecret failed: ${response.status} ${await response.text()}`)
  }
}
