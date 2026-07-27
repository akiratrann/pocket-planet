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

// Whatever the shell (or the platform) already set outranks the file: running
// `PORT=8935 npm run start` must bind 8935 even though .env names another port.
// process.loadEnvFile's own precedence has shifted between Node releases, so the
// values are snapshotted and put back rather than trusted to survive.
const fromEnvironment = { ...process.env };

try {
  process.loadEnvFile();
} catch {
  // No .env present — expected in production and in a fresh clone.
}

for (const [key, value] of Object.entries(fromEnvironment)) process.env[key] = value;
