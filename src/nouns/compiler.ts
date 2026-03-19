export interface NounSchemaField {
  name: string
  type: string
  required?: boolean
  unique?: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: string[] | Array<{ label: string; value: string }>
  fields?: NounSchemaField[]
  blocks?: Array<{ slug: string; fields: NounSchemaField[] }>
  defaultValue?: unknown
  label?: string
}

export interface NounSchema {
  fields: NounSchemaField[]
}

export interface CompiledField {
  name: string
  type: string
  required?: boolean
  unique?: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: string[] | Array<{ label: string; value: string }>
  fields?: CompiledField[]
  blocks?: Array<{ slug: string; fields: CompiledField[] }>
  defaultValue?: unknown
  label?: string
}

export interface CompiledCollectionConfig {
  slug: string
  fields: CompiledField[]
  timestamps: boolean
  admin?: { group?: string }
}

function compileField(f: NounSchemaField): CompiledField {
  const base: CompiledField = {
    name: f.name,
    type: f.type,
    required: f.required,
    unique: f.unique,
    label: f.label,
    defaultValue: f.defaultValue,
  }

  switch (f.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'code':
    case 'date':
    case 'number':
    case 'checkbox':
    case 'json':
    case 'richText':
    case 'point':
      return base

    case 'select':
    case 'radio':
      return { ...base, options: f.options ?? [], hasMany: f.hasMany }

    case 'relationship':
    case 'upload':
      return { ...base, relationTo: f.relationTo!, hasMany: f.hasMany }

    case 'array':
      return {
        ...base,
        fields: (f.fields ?? []).map(compileField),
      }

    case 'group':
      return {
        ...base,
        fields: (f.fields ?? []).map(compileField),
      }

    case 'blocks':
      return {
        ...base,
        blocks: (f.blocks ?? []).map(b => ({
          slug: b.slug,
          fields: b.fields.map(compileField),
        })),
      }

    default:
      // Unknown field type — fall back to json
      return { ...base, type: 'json' }
  }
}

export function nounToCollectionConfig(
  nounName: string,
  schema: NounSchema,
  group?: string,
): CompiledCollectionConfig {
  const slug = nounName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()

  return {
    slug,
    timestamps: true,
    admin: group ? { group } : undefined,
    fields: schema.fields.map(compileField),
  }
}
