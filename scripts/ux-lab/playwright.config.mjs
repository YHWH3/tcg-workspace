import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
const output=resolve(process.env.UX_OUTPUT??'.artifacts/ux-lab/latest');
const projects=['chromium','firefox','webkit'].flatMap(browserName=>[
  {label:'compact',width:390,height:844,touch:true},
  {label:'tablet',width:820,height:1180,touch:true},
  {label:'desktop',width:1440,height:900,touch:false},
].flatMap(size=>['light','dark'].map(colorScheme=>({name:`${browserName}-${size.label}-${colorScheme}`,use:{browserName,colorScheme,viewport:{width:size.width,height:size.height},hasTouch:size.touch,deviceScaleFactor:1,...(browserName==='chromium'?{launchOptions:{args:['--ignore-certificate-errors']}}:{})}}))));
export default defineConfig({
  testDir:'.',testMatch:'*.spec.mjs',fullyParallel:true,workers:1,retries:0,timeout:90_000,
  outputDir:resolve(output,'test-results'),
  snapshotPathTemplate:resolve('.artifacts/ux-lab/baselines/{projectName}/{arg}{ext}'),
  reporter:[['line'],['html',{outputFolder:resolve(output,'html'),open:'never'}],['json',{outputFile:resolve(output,'playwright.json')}]],
  expect:{timeout:15_000,toHaveScreenshot:{animations:'disabled',caret:'hide',maxDiffPixels:0}},
  use:{ignoreHTTPSErrors:true,serviceWorkers:'block',reducedMotion:'reduce',locale:'en-GB',timezoneId:'UTC',trace:'retain-on-failure',screenshot:'only-on-failure',video:'off'},
  projects,
});
