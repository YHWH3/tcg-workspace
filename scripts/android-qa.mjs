#!/usr/bin/env node
// Owns an ephemeral AVD, browser test children and cleanup; never adopts a USB
// device or touches an existing AVD/profile. Uses already-installed SDK images.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {freePort} from './certification/core.mjs';
import {command,fixtureEnvironment,eventually} from './phase4-fixture.mjs';
const root=resolve(import.meta.dirname,'..'),sdk=resolve(process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'));
const image=resolve(sdk,'system-images',process.argv.find(a=>a.startsWith('--image='))?.slice(8)??'android-35/google_apis/arm64-v8a');
if(!image.startsWith(join(sdk,'system-images')+'/')||!existsSync(join(image,'system.img')))throw new Error('An installed SDK system image is required');
const adb=join(sdk,'platform-tools/adb'),emulator=join(sdk,'emulator/emulator');
const out=resolve(process.env.CROSS_QA_ARTIFACT_DIR??`.artifacts/cross-platform/android-${Date.now()}`);mkdirSync(out,{recursive:true});
let port;
for(let candidate=5582;candidate<5600;candidate+=2){try{await freePort(candidate);await freePort(candidate+1);port=candidate;break;}catch{}}
if(!port)throw new Error('No unowned emulator console/ADB port pair available');
const serial=`emulator-${port}`,home=mkdtempSync(join(tmpdir(),'tcg-qa-avd-')),avd=join(home,'tcg_qa.avd');mkdirSync(avd);
writeFileSync(join(home,'tcg_qa.ini'),`avd.ini.encoding=UTF-8\npath=${avd}\ntarget=${image.split('/').findLast(s=>/^android-\d+$/.test(s))}\n`);
writeFileSync(join(avd,'config.ini'),`AvdId=tcg_qa\navd.ini.displayname=TCG disposable QA\nabi.type=arm64-v8a\nhw.cpu.arch=arm64\nhw.cpu.ncore=2\nhw.ramSize=2048\nhw.gpu.enabled=yes\nhw.gpu.mode=auto\nhw.lcd.width=720\nhw.lcd.height=1280\nhw.lcd.density=320\nhw.keyboard=yes\nhw.mainKeys=no\nhw.initialOrientation=Portrait\ndisk.dataPartition.size=6G\nimage.sysdir.1=${image}/\ntag.id=google_apis\n`);
const fd=openSync(join(out,'emulator.log'),'w',0o600),child=spawn(emulator,['-avd','tcg_qa','-port',String(port),'-no-window','-no-snapshot','-no-audio','-no-boot-anim'],{env:{...fixtureEnvironment(),ANDROID_AVD_HOME:home,ANDROID_HOME:sdk},stdio:['ignore',fd,fd],detached:true});
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};process.once('exit',stop);let exitCode=0;
try{
 await eventually(async()=>{try{return execFileSync(adb,['-s',serial,'shell','getprop','sys.boot_completed'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).trim()==='1'}catch{return false}},{timeout:180000});
 writeFileSync(join(out,'owned-device.json'),JSON.stringify({pid:child.pid,serial,avdHome:home,image,physical:false,existingAvdsUntouched:true},null,2));
 Object.assign(process.env,{QA_ANDROID_SERIAL:serial,ANDROID_ADB:adb,CROSS_QA_ARTIFACT_DIR:join(out,'chrome')});
 try{await command([process.execPath,join(root,'scripts/cross-platform-qa.mjs'),'--skip-build','--only=android','--android-pwa'],{timeout:300000,log:{write:s=>writeFileSync(join(out,'chrome.log'),s,{flag:'a'})},cwd:root});}catch(e){const resultPath=join(out,'chrome','results.json');const rows=existsSync(resultPath)?JSON.parse(readFileSync(resultPath)).results:[];exitCode=rows.length&&!rows.some(r=>r.status==='FAIL')&&rows.some(r=>r.status==='BLOCKED')?2:1;writeFileSync(join(out,'chrome-error.txt'),e.message);}
 // command() deliberately sanitizes credentials but inherits environment. Pass
 // only fixture identity knobs for the child, and restore them afterwards.
 const apk=process.env.FIREFOX_ANDROID_APK;
 if(apk){execFileSync(adb,['-s',serial,'install',resolve(apk)],{timeout:60000,stdio:'ignore'});
  Object.assign(process.env,{QA_ANDROID_SERIAL:serial,ANDROID_ADB:adb,CROSS_QA_ARTIFACT_DIR:join(out,'firefox')});
  try{await command([process.execPath,join(root,'scripts/firefox-device-qa.mjs'),'--skip-build'],{timeout:180000,log:{write:s=>writeFileSync(join(out,'firefox.log'),s,{flag:'a'})}});}catch(e){exitCode=1;writeFileSync(join(out,'firefox-error.txt'),e.message);}
 }
}finally{stop();await new Promise(r=>setTimeout(r,500));try{process.kill(-child.pid,'SIGKILL');}catch{}process.removeListener('exit',stop);closeSync(fd);}
process.exitCode=exitCode;console.log(out);
