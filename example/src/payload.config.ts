import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import sharp from 'sharp'
import { documentDBAdapter } from '../../dist/payload/database-adapter.js'

import { Users } from './collections/Users'
import { Posts } from './collections/Posts'
import { Tags } from './collections/Tags'
import { Agents } from './collections/Agents'
import { Models } from './collections/Models'
import { Chats } from './collections/Chats'
import { Messages } from './collections/Messages'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Posts, Tags, Agents, Models, Chats, Messages],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || 'example-app-secret-at-least-32-characters',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: documentDBAdapter({
    postgres: process.env.POSTGRES_URL!,
    ns: 'localhost',
  }),
  sharp,
})
