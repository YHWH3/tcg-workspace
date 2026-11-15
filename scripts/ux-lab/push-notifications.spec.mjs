import {test,expect,open,health} from './support.mjs';
import {surfaces} from './catalog.mjs';

// Browser API contract fixture. Encryption, session fencing and delivery run
// independently against actual disposable D1 and a simulated push sink.
test('device push: explicit permission, channel preferences and cleanup',async({page},info)=>{
  await page.addInitScript(()=>{
    window.__pushPermissionRequests=0;
    Object.defineProperty(window,'Notification',{configurable:true,value:class {
      static get permission(){return sessionStorage.getItem('ux-push-granted')==='1'?'granted':'default';}
      static async requestPermission(){window.__pushPermissionRequests++;sessionStorage.setItem('ux-push-granted','1');return 'granted';}
    }});
    Object.defineProperty(window,'PushManager',{configurable:true,value:class {}});
    const subscription={
      endpoint:'https://fcm.googleapis.com/send/synthetic-browser',
      toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'}};},
      async unsubscribe(){sessionStorage.removeItem('ux-push-subscribed');return true;},
    };
    const registration={pushManager:{
      async getSubscription(){return sessionStorage.getItem('ux-push-subscribed')==='1'?subscription:null;},
      async subscribe(){sessionStorage.setItem('ux-push-subscribed','1');return subscription;},
    },async getNotifications(){return [];}};
    Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:async()=>registration});
  });
  await page.route('**/api/push/config',route=>route.fulfill({json:{available:true,publicKey:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'}}));
  let registered=0,removed=0;
  await page.route('**/api/push/subscriptions',route=>{
    if(route.request().method()==='POST')registered++;else if(route.request().method()==='DELETE')removed++;
    return route.fulfill({json:{ok:true}});
  });
  await open(page,surfaces.find(surface=>surface.id==='settings'));
  expect(await page.evaluate(()=>window.__pushPermissionRequests)).toBe(0);
  const enable=page.getByRole('button',{name:'Enable on this device',exact:true});
  await enable.focus();await enable.press('Enter');
  const disable=page.getByRole('button',{name:'Turn off on this device',exact:true});
  await expect(disable).toBeVisible();
  expect(registered).toBe(1);
  expect(await page.evaluate(()=>window.__pushPermissionRequests)).toBe(1);
  const mentions=page.getByRole('checkbox',{name:'Push notifications for mentions',exact:true});
  await mentions.check();
  const titles=page.getByRole('checkbox',{name:'Include readable record titles in device notifications',exact:true});
  await expect(titles).not.toBeChecked();await titles.check();
  await expect(page.getByText('Saved',{exact:true})).toBeVisible();
  await page.reload();
  await expect(mentions).toBeChecked();await expect(titles).toBeChecked();
  await expect(disable).toBeVisible();
  await health(page,'device push settings',info);
  await disable.focus();await disable.press('Enter');
  await expect(enable).toBeVisible();
  expect(removed).toBe(1);
  expect(await page.evaluate(()=>sessionStorage.getItem('ux-push-subscribed'))).toBeNull();
});

test('device push: iPhone Home Screen instructions',async({page},info)=>{
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'});
  });
  await page.route('**/api/push/config',route=>route.fulfill({json:{available:true,publicKey:null}}));
  await open(page,surfaces.find(surface=>surface.id==='settings'));
  await expect(page.getByText('Open this page in Safari, tap Share, then Add to Home Screen. Open the installed app to enable notifications.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable on this device',exact:true})).toHaveCount(0);
  await health(page,'push Home Screen instructions',info);
});
