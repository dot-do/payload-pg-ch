import { describe, it, expect } from 'vitest'
import { whereToSQL } from './where.js'

describe('whereToSQL', () => {
  it('compiles simple equality on promoted column', () => {
    const result = whereToSQL({ status: { equals: 'published' } })
    expect(result.sql).toContain('data."status" = $1')
    expect(result.params).toEqual(['published'])
  })

  it('compiles JSON path query for non-promoted field', () => {
    const result = whereToSQL({ title: { equals: 'Hello' } })
    expect(result.sql).toContain("data.doc->>'title' = $1")
    expect(result.params).toEqual(['Hello'])
  })

  it('compiles nested AND', () => {
    const result = whereToSQL({
      and: [
        { status: { equals: 'published' } },
        { locale: { equals: 'en' } },
      ],
    })
    expect(result.sql).toContain('AND')
    expect(result.params).toEqual(['published', 'en'])
  })

  it('compiles nested OR', () => {
    const result = whereToSQL({
      or: [
        { status: { equals: 'draft' } },
        { status: { equals: 'published' } },
      ],
    })
    expect(result.sql).toContain('OR')
    expect(result.params).toEqual(['draft', 'published'])
  })

  it('compiles IN operator', () => {
    const result = whereToSQL({ status: { in: ['draft', 'published'] } })
    expect(result.sql).toContain('IN')
    expect(result.params).toEqual(['draft', 'published'])
  })

  it('compiles NOT IN operator', () => {
    const result = whereToSQL({ status: { not_in: ['archived'] } })
    expect(result.sql).toContain('NOT IN')
    expect(result.params).toEqual(['archived'])
  })

  it('compiles LIKE operator', () => {
    const result = whereToSQL({ title: { like: '%hello%' } })
    expect(result.sql).toContain('LIKE')
    expect(result.params).toEqual(['%hello%'])
  })

  it('compiles contains as ILIKE', () => {
    const result = whereToSQL({ title: { contains: 'hello' } })
    expect(result.sql).toContain('ILIKE')
    expect(result.params).toEqual(['%hello%'])
  })

  it('compiles greater_than', () => {
    const result = whereToSQL({ id: { greater_than: 100 } })
    expect(result.sql).toContain('>')
    expect(result.params).toEqual([100])
  })

  it('compiles less_than', () => {
    const result = whereToSQL({ id: { less_than: 50 } })
    expect(result.sql).toContain('<')
    expect(result.params).toEqual([50])
  })

  it('compiles exists for promoted column', () => {
    const result = whereToSQL({ status: { exists: true } })
    expect(result.sql).toContain('IS NOT NULL')
  })

  it('compiles exists for JSON field', () => {
    const result = whereToSQL({ title: { exists: true } })
    expect(result.sql).toContain("data.doc ? 'title'")
  })

  it('handles empty where', () => {
    const result = whereToSQL({})
    expect(result.sql).toBe('1=1')
    expect(result.params).toEqual([])
  })

  it('compiles complex nested query', () => {
    const result = whereToSQL({
      and: [
        { status: { equals: 'published' } },
        {
          or: [
            { title: { contains: 'hello' } },
            { title: { contains: 'world' } },
          ],
        },
      ],
    })
    expect(result.params.length).toBe(3)
    expect(result.sql).toContain('AND')
    expect(result.sql).toContain('OR')
  })

  it('respects startParam offset', () => {
    const result = whereToSQL({ status: { equals: 'published' } }, 'data', 5)
    expect(result.sql).toContain('$5')
    expect(result.params).toEqual(['published'])
  })
})
