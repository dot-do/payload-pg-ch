import { describe, it, expect } from 'vitest'
import { toSqid, fromSqid, registerPrefix, getPrefix, generateRand } from './sqids.js'

describe('sqids', () => {
  it('round-trips encode/decode', () => {
    const rand = 42317
    const created = new Date('2024-03-19T12:00:00Z')
    const sqid = toSqid('posts', 48291, 7, created, rand)

    expect(sqid).toMatch(/^pos_/)
    expect(sqid.length).toBeGreaterThan(14) // prefix + _ + minLength 10

    const decoded = fromSqid(sqid)
    expect(decoded.prefix).toBe('pos')
    expect(decoded.ns).toBe(7)
    expect(decoded.id).toBe(48291)
    expect(decoded.epoch).toBe(Math.floor(created.getTime() / 1000))
    expect(decoded.rand).toBe(rand)
  })

  it('derives prefix from collection slug', () => {
    expect(getPrefix('posts')).toBe('pos')
    expect(getPrefix('users')).toBe('usr')
    expect(getPrefix('media')).toBe('med')
    // Unknown collection falls back to first 3 chars
    expect(getPrefix('newsletters')).toBe('new')
  })

  it('custom prefix registration', () => {
    registerPrefix('newsletters', 'nws')
    expect(getPrefix('newsletters')).toBe('nws')
  })

  it('different ns values produce different sqids for same id', () => {
    const created = new Date('2024-01-01T00:00:00Z')
    const rand = 100
    const sqid1 = toSqid('posts', 1, 7, created, rand)
    const sqid2 = toSqid('posts', 1, 12, created, rand)
    expect(sqid1).not.toBe(sqid2)
  })

  it('rand makes sequential IDs non-guessable', () => {
    const created = new Date('2024-01-01T00:00:00Z')
    const sqid1 = toSqid('posts', 1, 7, created, 111)
    const sqid2 = toSqid('posts', 2, 7, created, 222)
    // The encoded parts should differ significantly
    const encoded1 = sqid1.split('_')[1]
    const encoded2 = sqid2.split('_')[1]
    expect(encoded1).not.toBe(encoded2)
  })

  it('throws on missing prefix separator', () => {
    expect(() => fromSqid('noseparator')).toThrow('missing prefix separator')
  })

  it('throws on invalid encoding', () => {
    expect(() => fromSqid('pos_!!!')).toThrow()
  })

  it('generateRand produces 16-bit values', () => {
    for (let i = 0; i < 100; i++) {
      const rand = generateRand()
      expect(rand).toBeGreaterThanOrEqual(0)
      expect(rand).toBeLessThan(65536)
    }
  })

  it('sqid is deterministic for same inputs', () => {
    const created = new Date('2024-06-15T08:30:00Z')
    const a = toSqid('pages', 999, 3, created, 54321)
    const b = toSqid('pages', 999, 3, created, 54321)
    expect(a).toBe(b)
  })
})
