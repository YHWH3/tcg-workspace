import { NavLink, useNavigate } from 'react-router';
import { Plus, Shapes } from 'lucide-react';
import { PresenceDots } from '../../core/presence';
import { IconButton } from '../../core/ui';
import { cn } from '../../core/utils';
import type { AppModule } from '../types';
import { createMoodboard, useMoodboards } from './api';
import { MoodCanvas } from './MoodCanvas';
import { MoodIndex } from './MoodIndex';

function MoodboardsSection() {
  const boards = useMoodboards();
  const navigate = useNavigate();
  const itemCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
      isActive ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-200',
    );
  return (
    <div className="px-2 pt-3">
      <div className="mb-0.5 flex items-center justify-between px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Mood boards</span>
        <IconButton className="h-5 w-5" aria-label="New mood board" onClick={async () => navigate(`/moodboards/${await createMoodboard()}`)}>
          <Plus size={13} />
        </IconButton>
      </div>
      {boards.map((b) => (
        <NavLink key={b.id} to={`/moodboards/${b.id}`} className={itemCls}>
          <span className="w-4 text-center text-xs leading-none">{String(b.icon ?? '🎨')}</span>
          <span className="min-w-0 flex-1 truncate">{String(b.title ?? '') || 'Untitled'}</span>
          <PresenceDots match={(p) => p === `/moodboards/${b.id}`} />
        </NavLink>
      ))}
    </div>
  );
}

export const moodboardsModule: AppModule = {
  id: 'moodboards',
  label: 'Mood boards',
  icon: Shapes,
  navItem: { path: '/moodboards', label: 'Mood boards', icon: Shapes },
  routes: [
    { path: 'moodboards', element: <MoodIndex /> },
    { path: 'moodboards/:boardId', element: <MoodCanvas /> },
  ],
  collections: ['moodboards', 'mooditems'],
  sidebarSection: MoodboardsSection,
};
