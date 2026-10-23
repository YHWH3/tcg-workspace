// Named states, not a claim that visiting a route covers all its workflows.
export const surfaces = [
  {id:'home',path:'/',ready:{placeholder:'Untitled'}},
  {id:'page',path:'/pages/ux-page',ready:{placeholder:'Untitled'}},
  {id:'databases',path:'/boards',ready:{role:'heading',name:'Boards'}},
  ...['table','list','gallery','board','calendar','timeline'].map(type=>({id:`records-${type}`,path:`/boards/ux-records/views/ux-${type}`,ready:{role:'heading',name:'🗃️ UX records'}})),
  {id:'task-detail',path:'/boards/ux-tasks/tasks/ux-task',ready:{role:'textbox',name:'Task title'}},
  {id:'moodboards-empty',path:'/moodboards',ready:{role:'heading',name:'Mood boards'}},
  {id:'forms-empty',path:'/forms/ux-records',ready:{role:'heading',name:/^Forms/}},
  {id:'automations-empty',path:'/automations/ux-records',ready:{role:'heading',name:/Automations/}},
  {id:'approvals-empty',path:'/approvals',ready:{role:'heading',name:'Approvals'}},
  {id:'activity',path:'/activity',ready:{role:'heading',name:'Activity'}},
  {id:'inbox',path:'/inbox',ready:{role:'heading',name:'Inbox'}},
  {id:'settings',path:'/settings',ready:{role:'heading',name:'Settings'}},
  {id:'ai-library-off',path:'/ai',ready:{role:'heading',name:'AI workflows'}},
  {id:'website',path:'/website',ready:{role:'heading',name:'Website'}},
  {id:'website-inbox',path:'/boards/board-website-inbox/views/view-wi-all',ready:{role:'heading',name:'🌐 Website inbox'}},
];
export const notCovered = [
  'Physical iPhone/iPad/Android/Windows hardware, native software keyboards, camera/microphone and OS permission dialogs',
  'Human assistive-technology assessment; native OS select popup positioning (separate headful review)',
  'Every combination of editor blocks, attachments, canvas gestures, public forms/shares, account lifecycle and AI approval states',
  'Production/provider/paid inference, email, payment and token behavior',
];
export const requiredCases=[...surfaces.map(s=>'surface: '+s.id),
  'visual reference: website inbox',
  'opened search: focus, empty results and recovery',
  'approvals network failure and recovery',
  'negative control: clipped labels must be detected',
  'profile: every avatar palette colour remains readable',
  'opened view controls: filters, sorting and properties',
  'table: horizontal recovery exposes complete controls',
  'text enlargement: 200 percent in inbox and task detail',
  'seeded interaction exploration: edit, offline, reload, resize, theme and search',
  'task draft: focus, cross-field edits and responsive recovery',
];
export const requiredProjects=['chromium','firefox','webkit'].flatMap(e=>['compact','tablet','desktop'].flatMap(v=>['light','dark'].map(t=>`${e}-${v}-${t}`)));
