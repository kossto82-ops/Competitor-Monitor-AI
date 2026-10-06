// CI helper: reads a vitest JSON report and fails when any test failed or was skipped.
//
// Why skipped tests are failures here: the infrastructure-backed suites (packages/db,
// packages/queue, the Redis rate limiter in apps/web) skip themselves when Postgres/Redis is
// unreachable. A skip reports as "not failed", so without this check a CI run with a broken
// service container would look green while testing nothing.
//
// Usage: node scripts/ci/assertNoSkippedTests.mjs <report.json> <label>
//
// Emits GitHub Actions workflow commands (::error::) so the offending test names show up as
// annotations on the run, not only inside a log that may require extra permissions to read.
import { readFileSync } from "node:fs";

const [reportPath, label = "tests"] = process.argv.slice(2);
if (!reportPath) {
  console.error("usage: node assertNoSkippedTests.mjs <report.json> <label>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.log(`::error title=${label}::could not read the vitest report at ${reportPath}: ${err.message}`);
  process.exit(1);
}

const notPassed = [];
for (const file of report.testResults ?? []) {
  const shortName = String(file.name).replace(/\\/g, "/").split("/").slice(-2).join("/");
  if (file.status === "failed" && (file.assertionResults ?? []).length === 0) {
    notPassed.push(`FILE FAILED ${shortName}: ${String(file.message ?? "").slice(0, 200)}`);
  }
  for (const test of file.assertionResults ?? []) {
    if (test.status !== "passed") notPassed.push(`${test.status.toUpperCase()} ${shortName} :: ${test.fullName}`);
  }
}

const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
console.log(`${label}: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${skipped} skipped`);

if (report.numFailedTests > 0 || skipped > 0 || notPassed.length > 0) {
  for (const line of notPassed.slice(0, 20)) console.log(`::error title=${label}::${line.replace(/\r?\n/g, " ")}`);
  console.log(`::error title=${label}::${report.numFailedTests} failed, ${skipped} skipped (see the individual annotations)`);
  process.exit(1);
}
