import { setupTestSchema } from './setup.js'

export async function setup() {
  try {
    await setupTestSchema()
  } catch {
    // Schema might already exist from a previous run — that's fine
  }
}
