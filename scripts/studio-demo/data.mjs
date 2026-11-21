const colors = {
  purple: '#8e4ec6',
  blue: '#0091ff',
  amber: '#f76b15',
  green: '#30a46c',
  pink: '#d6409f',
  red: '#e5484d',
};

const workstreams = [
  { id: 'design', name: 'Design', color: colors.purple },
  { id: 'engineering', name: 'Engineering', color: colors.blue },
  { id: 'operations', name: 'Operations', color: colors.amber },
  { id: 'editorial', name: 'Editorial', color: colors.green },
];

const stages = (titles, palette = [colors.purple, colors.blue, colors.amber, colors.green]) =>
  titles.map((name, index) => ({ id: 'stage-' + (index + 1), name, color: palette[index] }));

const fields = (groupName, options = workstreams) => [
  { id: 'progress', name: 'Progress', type: 'number', format: 'percent', showOnCard: true },
  { id: 'group', name: groupName, type: 'select', options, showOnCard: true },
  { id: 'start', name: 'Start', type: 'date' },
];

export const boards = [
  {
    id: 'sample-to-dos', name: 'To-dos', icon: '✅', kind: 'tasks', recordNoun: 'Task',
    description: 'Day-to-day work across the studio.',
    columns: stages(['To do', 'In progress', 'In review', 'Done']),
    fields: fields('Team'),
    records: [
      ['Outline the December brief', 1, 0, 'editorial', 7, 4, 'Collect the three stories the studio wants to share next month.'],
      ['Request print quotes', 1, 0, 'operations', 4, 3, 'Ask the shortlist for pricing on the exhibition guide.'],
      ['Map the signup journey', 1, 0, 'design', 8, 4, 'Sketch the path from first visit to confirmation.'],
      ['Design the workshop landing page', 2, .5, 'design', 3, 7, 'The first layout is ready. Next, compare the mobile and desktop versions.'],
      ['Connect the event calendar', 2, .7, 'engineering', 5, 8, 'The calendar reads planned dates. The timezone and edits are being checked.'],
      ['Organize the photo archive', 2, .25, 'operations', 9, 10, 'The first folder is tagged. Sort the remaining contact sheets by project.'],
      ['Review the studio newsletter', 3, .9, 'editorial', 1, 5, 'The copy is ready for a final pass on links and heading order.'],
      ['Check mobile navigation', 3, .85, 'engineering', 2, 6, 'The compact layout is ready for keyboard and touch review.'],
      ['Approve the workshop identity', 3, .95, 'design', 3, 7, 'Review contrast and legibility on the poster and event card.'],
      ['Publish the event recap', 4, 1, 'editorial', -2, 4, 'The recap and credits are published.'],
      ['Set up the project handoff', 4, 1, 'operations', -4, 6, 'The delivery folder and approval checklist are ready.'],
      ['Build the project index', 4, 1, 'engineering', -5, 9, 'The studio can navigate active and completed projects from one page.'],
    ],
    views: [
      { name: 'Board', type: 'board' },
      { name: 'Grid', type: 'table', visible: ['title', 'status', 'Team', 'Progress', 'dueDate', 'assigneeId'] },
      { name: 'Calendar', type: 'calendar', dateKey: 'dueDate' },
      { name: 'Timeline', type: 'timeline', dateKey: 'Start', endDateKey: 'dueDate', timelineScale: 'month' },
      { name: 'Dashboard', type: 'dashboard', dateKey: 'dueDate' },
      { name: 'Chart', type: 'chart', chart: { chartType: 'bar', xKey: 'status', yAgg: 'count' } },
      { name: 'List', type: 'list', sorts: [{ field: 'dueDate', dir: 'asc' }], visible: ['status', 'Team', 'dueDate'] },
      { name: 'Gallery', type: 'gallery', visible: ['status', 'Team', 'Progress'] },
      { name: 'Feed', type: 'feed', visible: ['status', 'Team', 'createdAt'] },
      { name: 'By team', type: 'board', groupBy: 'Team', visible: ['status', 'Progress'] },
    ],
  },
  {
    id: 'sample-projects', name: 'Projects', icon: '🗂️', kind: 'records', recordNoun: 'Project',
    description: 'A portfolio with separate planning, delivery and sign-off stages.',
    columns: stages(['Planning', 'Active', 'Sign-off', 'Delivered'], [colors.blue, colors.purple, colors.pink, colors.green]),
    fields: fields('Lead team'),
    records: [
      ['Winter workshop series', 1, .15, 'operations', 10, 13, 'Confirm venues, budget and the facilitator shortlist.'],
      ['Community resource library', 1, .1, 'editorial', 9, 12, 'Draft the first collection and decide how to tag resources.'],
      ['Studio website refresh', 2, .6, 'engineering', 6, 16, 'The first round of pages is in review. The schedule tracks visual QA and publication.'],
      ['Field Notes editorial relaunch', 2, .45, 'editorial', 8, 16, 'Collect the launch issue, interviews and the newsletter edition.'],
      ['Accessible toolkit', 2, .3, 'design', 9, 11, 'Create reusable components and document their keyboard behavior.'],
      ['Harbour exhibition guide', 3, .9, 'design', 3, 16, 'The print proof is with the production team for sign-off.'],
      ['Volunteer onboarding', 3, .85, 'operations', 5, 13, 'Test the guide with a new volunteer and revise the first-week steps.'],
      ['Annual studio report', 4, 1, 'editorial', -3, 16, 'The report is archived with source figures and image credits.'],
    ],
    views: [
      { name: 'Portfolio board', type: 'board' },
      { name: 'Roadmap', type: 'timeline', dateKey: 'Start', endDateKey: 'dueDate', timelineScale: 'month' },
      { name: 'Portfolio dashboard', type: 'dashboard', dateKey: 'dueDate' },
    ],
  },
  {
    id: 'sample-editorial', name: 'Editorial', icon: '📝', kind: 'records', recordNoun: 'Story',
    description: 'An editorial pipeline plus a publishing calendar and update feed.',
    columns: stages(['Pitch', 'Draft', 'Copy edit', 'Published'], [colors.pink, colors.purple, colors.blue, colors.green]),
    fields: fields('Format', [
      { id: 'article', name: 'Article', color: colors.purple },
      { id: 'newsletter', name: 'Newsletter', color: colors.blue },
      { id: 'interview', name: 'Interview', color: colors.amber },
    ]),
    records: [
      ['How a print run comes together', 1, 0, 'article', 8, 3, 'Follow the guide from a rough layout to a finished print run.'],
      ['Meet the workshop facilitators', 1, .1, 'interview', 7, 4, 'Prepare three questions for each facilitator.'],
      ['The studio reading list', 2, .45, 'article', 4, 6, 'The designers have submitted six recommendations.'],
      ['November dispatch', 2, .65, 'newsletter', 6, 8, 'The issue covers the workshops, exhibition and reading list.'],
      ['A conversation with the archivist', 3, .9, 'interview', 1, 7, 'Verify names and confirm the image caption.'],
      ['Behind the exhibition guide', 3, .85, 'article', 3, 8, 'Check the credits before publication.'],
      ['October dispatch', 4, 1, 'newsletter', -4, 8, 'The edition has been published and archived.'],
      ['What we learned at the open studio', 4, 1, 'article', -2, 6, 'The recap includes notes from three members of the team.'],
    ],
    views: [
      { name: 'Editorial board', type: 'board' },
      { name: 'Publishing calendar', type: 'calendar', dateKey: 'dueDate' },
      { name: 'Story feed', type: 'feed', visible: ['status', 'Format', 'createdAt'] },
    ],
  },
  {
    id: 'sample-requests', name: 'Requests', icon: '📥', kind: 'records', recordNoun: 'Request',
    description: 'Incoming work grouped by review stage, with a draft intake form.',
    columns: stages(['Received', 'Triaging', 'Waiting', 'Resolved'], [colors.blue, colors.purple, colors.amber, colors.green]),
    fields: fields('Request type', [
      { id: 'event', name: 'Event', color: colors.purple },
      { id: 'design', name: 'Design', color: colors.pink },
      { id: 'support', name: 'Support', color: colors.blue },
    ]),
    records: [
      ['Book a room for the poster workshop', 1, 0, 'event', 5, 3, 'Check availability for twelve participants and one facilitator.'],
      ['Request a new homepage banner', 1, 0, 'design', 6, 3, 'Prepare a small banner for the resource library launch.'],
      ['Add transcripts to event videos', 2, .3, 'support', 7, 5, 'Scope three videos and confirm the transcript format.'],
      ['Create directions for visiting guests', 2, .45, 'design', 4, 4, 'Collect the arrival details and accessible entrance information.'],
      ['Schedule a team portfolio review', 3, .7, 'event', 8, 5, 'Waiting on final availability from the team.'],
      ['Organize shared project files', 3, .75, 'support', 4, 7, 'Confirm file owners before moving the shared folders.'],
      ['Update the reading list link', 4, 1, 'support', -2, 3, 'The link has been replaced and the page checked.'],
      ['Prepare workshop feedback cards', 4, 1, 'design', -3, 6, 'The team approved the feedback card and print spec.'],
    ],
    views: [
      { name: 'Triage board', type: 'board' },
      { name: 'Request grid', type: 'table', visible: ['title', 'status', 'Request type', 'dueDate'] },
      { name: 'Request breakdown', type: 'chart', chart: { chartType: 'bar', xKey: 'Request type', yAgg: 'count' } },
    ],
  },
];
