// Loads `.env` from the repository root before anything else runs. This
// replaces the automatic .env loading the framework used to do, and it must be
// the FIRST import of server/index.js because Prisma resolves DATABASE_URL when
// the client is constructed.

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env file — rely on the real environment / defaults
}