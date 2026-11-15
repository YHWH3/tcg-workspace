import {test, expect, open, health, request, readRecord} from './support.mjs';

test('Chart view: configure, drill down by keyboard, show data table and reflow', async ({page}, info) => {
  const suffix = info.project.name.replaceAll('-','')+'-'+Date.now();
  const database = 'chart-db-'+suffix, view = 'chart-view-'+suffix, record = 'chart-item-'+suffix;
  const model = {chartType:'bar', xKey:'p_category', yAgg:'count'};
  let createdView;
  const rows = [
    {id:database, collection:'boards', patch:{kind:'records', name:'Chart test', fields:[
      {id:'category', name:'Category', type:'text'}, {id:'value', name:'Amount', type:'number'},
    ]}},
    {id:view, collection:'views', patch:{databaseId:database, name:'Chart data', type:'chart', order:'a0', config:{chart:model}}},
    {id:record, collection:'tasks', patch:{boardId:database, title:'Source record', p_category:'Community', p_value:16}},
  ];
  const write = async changes => expect((await request('/api/sync/push', {
    protocol:3, changes:changes.map(row => ({...row, ts:Date.now()})),
  })).rejectedItems).toEqual([]);
  await write(rows);
  try {
    await open(page, {id:'chart-view', path:`/boards/${database}/views/${view}`,
      ready:{role:'region',name:'Chart data'}});
    const chart = page.getByRole('region',{name:'Chart data',exact:true});
    await expect(chart.getByText('1 matching record')).toBeVisible();
    await chart.getByRole('button',{name:'Chart settings',exact:true}).press('Enter');
    await page.getByLabel('Summarize by',{exact:true}).selectOption('sum');
    await page.getByRole('button',{name:'Save chart',exact:true}).press('Enter');
    await expect.poll(async () => (await readRecord(view))?.data.config.chart).toMatchObject({yAgg:'sum', yKey:'p_value'});
    const point = chart.getByRole('button',{name:/Community, 16, 1 record/});
    await point.press('Enter');
    const dialog = page.getByRole('dialog',{name:'Chart records'});
    await expect(dialog.getByRole('link',{name:'Source record',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(point).toBeFocused();
    await chart.getByRole('button',{name:'Show as table',exact:true}).click();
    await expect(chart.getByRole('table')).toContainText('Community');
    await expect(chart.getByRole('table')).toContainText('16');
    await page.addStyleTag({content:'html{font-size:200%!important}'});
    await health(page,'chart table reflow',info);
    await chart.getByRole('button',{name:'Show chart',exact:true}).click();
    await health(page,'chart plot reflow',info);
    await page.getByRole('button',{name:'New view',exact:true}).press('Enter');
    await page.getByRole('button',{name:'Chart',exact:true}).press('Enter');
    await expect(page.getByRole('region',{name:'Chart',exact:true})).toBeVisible();
    createdView = new URL(page.url()).pathname.split('/').at(-1);
    await expect(page.getByRole('region',{name:'Chart',exact:true})).toContainText('1 matching record');
    await expect.poll(async () => (await readRecord(createdView))?.data.type).toBe('chart');
  } finally {
    const cleanup = rows.map(({id, collection}) => ({id, collection, patch:{deleted:true}}));
    if (createdView && await readRecord(createdView)) cleanup.unshift({id:createdView, collection:'views', patch:{deleted:true}});
    await write(cleanup);
  }
});
