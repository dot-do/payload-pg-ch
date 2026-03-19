import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface GenerateMigrationArgs {
  name: string
  migrationsRoot: string
  pgUp?: string
  pgDown?: string
  chUp?: string
  chDown?: string
  requiresResync?: boolean
  affects?: string[]
  notes?: string
}

export async function generateMigration(args: GenerateMigrationArgs): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dirName = `${timestamp}_${args.name}`
  const dirPath = join(args.migrationsRoot, dirName)

  await mkdir(dirPath, { recursive: true })

  const meta = {
    name: dirName,
    created: new Date().toISOString(),
    requires_resync: args.requiresResync ?? false,
    affects: args.affects ?? [],
    notes: args.notes,
  }

  await writeFile(join(dirPath, 'meta.json'), JSON.stringify(meta, null, 2))
  await writeFile(join(dirPath, 'pg.up.sql'), args.pgUp ?? '-- No PG changes\n')
  await writeFile(join(dirPath, 'pg.down.sql'), args.pgDown ?? '-- No PG rollback\n')
  await writeFile(join(dirPath, 'ch.up.sql'), args.chUp ?? '-- No CH changes\n')
  await writeFile(join(dirPath, 'ch.down.sql'), args.chDown ?? '-- No CH rollback\n')

  return dirPath
}
