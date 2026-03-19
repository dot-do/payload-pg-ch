export interface ToolPermissions {
  allow?: string[]
  deny?: string[]
}

export function evaluateToolAccess(
  permissions: ToolPermissions,
  toolName: string,
): boolean {
  // Deny list takes priority
  if (permissions.deny) {
    for (const pattern of permissions.deny) {
      if (matchPattern(pattern, toolName)) return false
    }
  }

  // Check allow list
  if (permissions.allow) {
    for (const pattern of permissions.allow) {
      if (matchPattern(pattern, toolName)) return true
    }
  }

  // Default: deny if allow list exists but didn't match
  return false
}

function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true

  // Wildcard matching: 'read.*' matches 'read.file', 'read.database'
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return value.startsWith(prefix + '.') || value === prefix
  }

  return false
}
