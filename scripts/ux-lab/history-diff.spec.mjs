import {test, expect, open, health, request, readRecord} from './support.mjs';

test('History diff: selected fields, body movement, restore, keyboard and enlarged text', async ({page}, info) => {
  const suffix = info.project.name.replaceAll('-', '') + Date.now();
  const record = 'history-' + suffix, destination = 'destination-' + suffix, block = 'answer-' + suffix;
  const write = async rows => expect((await request('/api/sync/push', {protocol:3, changes:rows.map(row => ({...row,ts:Date.now()}))})).rejectedItems).toEqual([]);
  const first = {title:'Green garden',description:'Old description'};
  await write([{id:record,collection:'pages',patch:first}, {id:destination,collection:'pages',patch:{title:'Destination'}}]);
  await write([{id:record,collection:'pages',patch:{title:'Blue garden',description:'New description'}},
    {id:block,collection:'blocks',patch:{pageId:record,type:'p',text:'Original answer 👨‍👩‍👧‍👦 नमस्ते'}}]);
  await write([{id:block,collection:'blocks',patch:{text:'Revised answer 👨‍👩‍👧‍👦 नमस्ते'}}]);
  await write([{id:block,collection:'blocks',patch:{pageId:destination}}]);
  try {
    await open(page, {id:'history-source',path:`/pages/${record}`,ready:{placeholder:'Untitled'}});
    const trigger = page.getByRole('button', {name:'History',exact:true});
    await trigger.press('Enter');
    const history = page.getByRole('dialog', {name:'Record history'});
    await expect(history.getByLabel('Revision', {exact:true})).toBeVisible();
    const title = history.getByRole('region', {name:'Change to title'});
    await expect(title.locator('del')).toHaveText('Green');
    await expect(title.locator('ins')).toHaveText('Blue');
    await history.getByRole('checkbox',{name:'Select title for restore',exact:true}).check();
    await history.getByRole('checkbox',{name:'Select description for restore',exact:true}).check();
    await history.getByRole('button',{name:'Preview restore selected fields'}).press('Enter');
    await history.getByRole('button',{name:'Restore these fields',exact:true}).press('Enter');
    await expect.poll(async () => (await readRecord(record))?.data.title).toBe(first.title);
    await expect.poll(async () => (await readRecord(record))?.data.description).toBe(first.description);
    await history.getByRole('button',{name:'Body changes',exact:true}).press('Enter');
    await expect(history.getByRole('heading',{name:/Block removed/})).toBeVisible();
    await expect(history).toContainText('Revised answer');
    const revisions = history.getByLabel('Revision',{exact:true});
    const edited = await revisions.locator('option').nth(1).getAttribute('value');
    await revisions.selectOption(edited);
    const answer = history.getByRole('region',{name:'Change to text'});
    await expect(answer.locator('del')).toHaveText('Original');
    await expect(answer.locator('ins')).toHaveText('Revised');
    await page.addStyleTag({content:'html{font-size:200%!important}'});
    await answer.scrollIntoViewIfNeeded();
    await expect(answer.locator('del')).toBeInViewport();
    await expect(answer.locator('ins')).toBeInViewport();
    await health(page,'history enlarged diff',info);
    await info.attach('history-enlarged',{body:await page.screenshot(),contentType:'image/png'});
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  } finally {
    await write([{id:block,collection:'blocks',patch:{deleted:true}}, {id:record,collection:'pages',patch:{deleted:true}}, {id:destination,collection:'pages',patch:{deleted:true}}]);
  }
});
