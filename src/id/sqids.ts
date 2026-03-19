import Sqids from 'sqids'

// Default alphabet — matches ClickHouse's sqidEncode/sqidDecode
const sqids = new Sqids({ minLength: 10 })

// Collection slug → 3-char prefix registry
const PREFIXES: Record<string, string> = {
  posts: 'pos',
  pages: 'pag',
  users: 'usr',
  media: 'med',
  actions: 'act',
  events: 'evt',
  versions: 'ver',
  search: 'sch',
  products: 'prd',
  orders: 'ord',
  comments: 'cmt',
  categories: 'cat',
  tags: 'tag',
}

export function registerPrefix(collection: string, prefix: string): void {
  PREFIXES[collection] = prefix
}

export function getPrefix(collection: string): string {
  return PREFIXES[collection] ?? collection.slice(0, 3)
}

export function toSqid(
  collection: string,
  id: number,
  ns: number,
  created: Date,
  rand: number,
): string {
  const prefix = getPrefix(collection)
  const epoch = Math.floor(created.getTime() / 1000)
  return `${prefix}_${sqids.encode([ns, id, epoch, rand])}`
}

export function fromSqid(sqid: string): {
  prefix: string
  ns: number
  id: number
  epoch: number
  rand: number
} {
  const underscoreIdx = sqid.indexOf('_')
  if (underscoreIdx === -1) {
    throw new Error(`Invalid sqid: missing prefix separator`)
  }
  const prefix = sqid.slice(0, underscoreIdx)
  const encoded = sqid.slice(underscoreIdx + 1)
  const decoded = sqids.decode(encoded)
  if (decoded.length < 4) {
    throw new Error(`Invalid sqid: expected 4 components, got ${decoded.length}`)
  }
  const [ns, id, epoch, rand] = decoded

  // Canonicality check: re-encode and compare
  const reencoded = sqids.encode([ns, id, epoch, rand])
  if (reencoded !== encoded) {
    throw new Error(`Invalid sqid: non-canonical encoding`)
  }

  return { prefix, ns, id, epoch, rand }
}

export function generateRand(): number {
  const arr = new Uint16Array(1)
  crypto.getRandomValues(arr)
  return arr[0]
}
