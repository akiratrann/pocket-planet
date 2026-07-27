// Loads .env into process.env for local development.
//
// This must be the FIRST import in server/index.ts: ES module imports are
// evaluated in order, so anything imported before this would read process.env
// before the file has been applied.
//
// Uses Node's built-in process.loadEnvFile() (Node 20.12+) rather than the
// dotenv package — no dependency, and it can't drift out of sync with the
// runtime. In production (Fly) the platform injects real environment variables
// and no .env file exists, so a missing file is the normal case, not an error.

try {
  process.loadEnvFile();
} catch {
  // No .env present — expected in production and in a fresh clone.
}
