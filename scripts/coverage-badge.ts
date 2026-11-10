/**
 * Turns an lcov report into the JSON that shields.io's endpoint badge reads.
 *
 *   node scripts/coverage-badge.ts coverage/lcov.info coverage/coverage.json
 *
 * CI runs this on main and publishes the JSON to the `badges` branch, which the README badge points
 * at, so the number follows the code without anyone editing the README.
 */
import { readFile, writeFile } from "node:fs/promises";

/** Line coverage as a percentage of the lines the report instruments, or undefined when it has none. */
export function lineCoverage(lcov: string): number | undefined {
  let found = 0;
  let hit = 0;
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("LF:")) found += Number(line.slice(3));
    else if (line.startsWith("LH:")) hit += Number(line.slice(3));
  }
  return found > 0 ? (hit / found) * 100 : undefined;
}

function colorFor(percent: number): string {
  if (percent >= 95) return "8A6220";
  if (percent >= 90) return "97CA00";
  if (percent >= 75) return "DFB317";
  return "E05D44";
}

const [input, output, extra] = process.argv.slice(2);
if (!input || !output || extra !== undefined) {
  process.stderr.write("Usage: coverage-badge <lcov.info> <badge.json>\n");
  process.exit(1);
}
const percent = lineCoverage(await readFile(input, "utf8"));
if (percent === undefined) {
  process.stderr.write("The lcov report has no instrumented lines.\n");
  process.exit(1);
}
const badge = { schemaVersion: 1, label: "coverage", message: `${Math.floor(percent)}%`, color: colorFor(percent) };
await writeFile(output, `${JSON.stringify(badge)}\n`);
process.stdout.write(`coverage: ${badge.message}\n`);
