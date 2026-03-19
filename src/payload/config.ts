// Payload collection definitions for ClickHouse-backed read-only collections
// and helper generators for standard collections

export function eventsCollection() {
  return {
    slug: 'events',
    admin: { readOnly: true },
    fields: [
      { name: 'kind', type: 'text' as const },
      { name: 'entity', type: 'number' as const },
      { name: 'actor', type: 'number' as const },
      { name: 'ts', type: 'date' as const },
      { name: 'payload', type: 'json' as const },
      { name: 'meta', type: 'json' as const },
    ],
  }
}

export function versionsCollection() {
  return {
    slug: 'versions',
    admin: { readOnly: true },
    fields: [
      { name: 'entity', type: 'number' as const },
      { name: 'version', type: 'number' as const },
      { name: 'doc', type: 'json' as const },
      { name: 'diff', type: 'json' as const },
      { name: 'commit', type: 'text' as const },
      { name: 'author', type: 'number' as const },
      { name: 'published', type: 'checkbox' as const },
    ],
  }
}

export function usersCollection(opts?: { disableLocal?: boolean }) {
  return {
    slug: 'users',
    auth: {
      disableLocalStrategy: opts?.disableLocal ?? true,
    },
    fields: [
      { name: 'workosId', type: 'text' as const, unique: true, admin: { readOnly: true } },
      { name: 'email', type: 'email' as const, unique: true },
      { name: 'name', type: 'text' as const },
      { name: 'githubId', type: 'number' as const, admin: { readOnly: true } },
    ],
  }
}

export function nsCollection() {
  return {
    slug: 'namespaces',
    admin: { useAsTitle: 'name' },
    fields: [
      { name: 'uri', type: 'text' as const, required: true, unique: true },
      { name: 'name', type: 'text' as const },
      { name: 'plan', type: 'select' as const, options: ['free', 'pro', 'enterprise'], defaultValue: 'free' },
      { name: 'kind', type: 'select' as const, options: ['production', 'staging', 'preview', 'branch'], defaultValue: 'production' },
      { name: 'repo', type: 'text' as const },
      { name: 'branch', type: 'text' as const, defaultValue: 'main' },
      { name: 'root', type: 'text' as const, defaultValue: '/' },
    ],
  }
}
