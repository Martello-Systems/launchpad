import { execSync } from "child_process";
import { beforeAll } from "vitest";

// Point Prisma at the dedicated test database BEFORE any client is created.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run tests with TEST_DATABASE_URL pointing at a throwaway Postgres database."
  );
}
process.env.DATABASE_URL = testUrl;

beforeAll(() => {
  // Apply the committed migrations to the test DB once per run. `migrate deploy`
  // is idempotent and non-interactive — safe for CI.
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
});
