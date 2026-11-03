// Keep future phase D1 regressions inside the dedicated database/cost gate.
export function d1TestFiles(testFiles) {
  return testFiles.filter(file => /(?:phase(?:[4-9]|1[0-3])|audit|assistant)-.*-d1\.test\.ts$/.test(file));
}

// Dedicated D1 files execute once. Legacy files outside that selection remain
// in unit; the two groups together must cover the complete discovered inventory.
export function partitionTestFiles(testFiles) {
  const d1=d1TestFiles(testFiles),selected=new Set(d1);
  return {unit:testFiles.filter(file=>!selected.has(file)),d1};
}
