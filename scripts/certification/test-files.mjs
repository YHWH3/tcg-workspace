// Keep future phase D1 regressions inside the dedicated database/cost gate.
export function d1TestFiles(testFiles) {
  return testFiles.filter(file => /(?:phase(?:[4-9]|1[0-3])|audit|assistant)-.*-d1\.test\.ts$/.test(file));
}
