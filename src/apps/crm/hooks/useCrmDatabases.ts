import { useCallback, useMemo, useState } from 'react';
import { findReusableBoards, type AuthorTemplate } from '../../../../shared/bundled';
import { BUNDLED_TEMPLATES } from '../../../core/bundledTemplates';
import { useLinks, type DbLinkRow } from '../../../core/links';
import { useAllViews, type DbViewRow } from '../../../core/records';
import { WEBSITE_INBOX_ID, WEBSITE_PEOPLE_ID } from '../../../../shared/websiteInbox';
import { useBoards, useTasks, type BoardRow, type TaskRow } from '../../../modules/boards/api';
import { instantiateTemplate } from '../../../modules/pages/api';

export interface CrmDatabasesState {
  boards: BoardRow[];
  tasks: TaskRow[];
  views: DbViewRow[];
  links: DbLinkRow[];
  peopleDb: BoardRow | undefined;
  orgsDb: BoardRow | undefined;
  programsDb: BoardRow | undefined;
  affiliationsDb: BoardRow | undefined;
  applicationsDb: BoardRow | undefined;
  activitiesDb: BoardRow | undefined;
  opportunitiesDb: BoardRow | undefined;
  projectsDb: BoardRow | undefined;
  eventsDb: BoardRow | undefined;
  placesDb: BoardRow | undefined;
  websiteInboxDb: BoardRow | undefined;
  needsPackInstall: boolean;
  installingPack: boolean;
  installError: string | null;
  installCrmPack: () => Promise<void>;
}

function findBoardByKey(boards: readonly BoardRow[], key: string, fallbackIds: string[] = []): BoardRow | undefined {
  return (
    boards.find((b) => !b.deleted && !b.archived && b.templateDbKey === key) ??
    boards.find((b) => !b.deleted && !b.archived && fallbackIds.includes(b.id)) ??
    boards.find((b) => !b.deleted && !b.archived && String(b.name ?? '').toLowerCase() === key)
  );
}

export function useCrmDatabases(): CrmDatabasesState {
  const boards = useBoards();
  const tasks = useTasks();
  const views = useAllViews();
  const links = useLinks();
  const [installingPack, setInstallingPack] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const resolved = useMemo(() => {
    const peopleDb =
      findBoardByKey(boards, 'people', [WEBSITE_PEOPLE_ID]) ??
      boards.find((b) => !b.deleted && !b.archived && /^people$/i.test(String(b.name ?? '').trim()));
    const orgsDb =
      findBoardByKey(boards, 'organizations') ??
      boards.find((b) => !b.deleted && !b.archived && /^organi[sz]ations$/i.test(String(b.name ?? '').trim()));
    const programsDb = findBoardByKey(boards, 'programs');
    const affiliationsDb = findBoardByKey(boards, 'affiliations');
    const applicationsDb = findBoardByKey(boards, 'applications');
    const activitiesDb = findBoardByKey(boards, 'activities');
    const opportunitiesDb = findBoardByKey(boards, 'opportunities');
    const projectsDb = findBoardByKey(boards, 'projects');
    const eventsDb = findBoardByKey(boards, 'events');
    const placesDb = findBoardByKey(boards, 'places');
    const websiteInboxDb = boards.find((b) => !b.deleted && b.id === WEBSITE_INBOX_ID);
    const needsPackInstall =
      !peopleDb ||
      !orgsDb ||
      !programsDb ||
      !applicationsDb ||
      !activitiesDb ||
      !opportunitiesDb;
    return {
      peopleDb,
      orgsDb,
      programsDb,
      affiliationsDb,
      applicationsDb,
      activitiesDb,
      opportunitiesDb,
      projectsDb,
      eventsDb,
      placesDb,
      websiteInboxDb,
      needsPackInstall,
    };
  }, [boards]);

  const installCrmPack = useCallback(async () => {
    const bundle = BUNDLED_TEMPLATES.find((t) => t.key === 'tcg-pack');
    if (!bundle || installingPack) return;
    setInstallingPack(true);
    setInstallError(null);
    try {
      const authorLike: AuthorTemplate = {
        name: bundle.name,
        description: bundle.description,
        icon: bundle.icon,
        databases: Object.entries(bundle.snapshot.boards ?? {}).map(([id, b]) => ({
          id,
          key: b.key as string | undefined,
          name: String(b.name ?? ''),
        })),
        pages: [],
      };
      const reuseBoards = findReusableBoards(boards, authorLike);
      await instantiateTemplate(bundle.root, {
        snapshot: bundle.snapshot,
        templateKey: bundle.key,
        reuseBoards,
        packInstall: true,
        preserveTemplates: true,
        stableIds: true,
      });
    } catch {
      setInstallError('Could not initialise the TCG database pack. Retry when connected.');
    } finally {
      setInstallingPack(false);
    }
  }, [boards, installingPack]);

  return {
    boards,
    tasks,
    views,
    links,
    ...resolved,
    installingPack,
    installError,
    installCrmPack,
  };
}
