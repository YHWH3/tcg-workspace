#!/usr/bin/env node
// Generate an unexecuted evidence packet; never infers physical-device PASS.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const output=resolve(process.argv[2]??'.artifacts/hardware-acceptance');
const target=join(output,'evidence.json');
if(existsSync(target))throw new Error('Evidence already exists; select a new output directory to preserve it');
mkdirSync(output,{recursive:true});
const source={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim()};
const cases=['H01 sign-in and Unicode persistence','H02 touch, keyboard, rotation and canvas','H03 installed PWA offline cold relaunch','H04 camera, microphone and native file provider','H05 suspension and storage pressure','H06 human screen reader','H07 native 400 percent zoom and focus','H08 human approval and exactly-once persistence'];
const devices=['Physical iPhone Safari','Physical iPad Safari','Physical Android Chrome','Desktop browser and human screen reader'];
writeFileSync(target,JSON.stringify({source,created:new Date().toISOString(),fixtureOrigin:null,operator:null,privacy:'Synthetic data only; never include tokens, cookies, credentials or personal records',devices:devices.map(device=>({device,hardwareModel:null,osBuild:null,browserVersion:null,assistiveTechnology:null,cases:cases.map(name=>({name,status:'NOT RUN',timestamp:null,steps:null,expected:null,observed:null,screenshots:[],serverEvidence:null,reason:null}))}))},null,2)+'\n',{mode:0o600});
console.log(target);
