import { NavLink, useNavigate } from 'react-router';
import { CheckSquare, Plus } from 'lucide-react';
import { IconButton } from '../../core/ui';
import { cn } from '../../core/utils';
import { createBoard, useBoards } from './api';

/** Sidebar: boards list + My tasks + create board. */
export function BoardsSection() {
  const boards = useBoards();
  const navigate = useNavigate();
  const itemCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
      isActive ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-200',
    );

  return (
    <div className="px-2">
      <div className="mb-0.5 flex items-center justify-between px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Boards</span>
        <IconButton
          className="h-5 w-5"
          aria-label="New board"
          onClick={async () => navigate(`/boards/${await createBoard('Untitled board')}`)}
        >
          <Plus size={13} />
        </IconButton>
      </div>
      <NavLink to="/tasks" className={itemCls}>
        <CheckSquare size={15} strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">My tasks</span>
      </NavLink>
      {boards.map((b) => (
        <NavLink key={b.id} to={`/boards/${b.id}`} className={itemCls}>
          <span className="w-4 text-center text-xs leading-none">{String(b.icon ?? '🗂️')}</span>
          <span className="min-w-0 flex-1 truncate">{String(b.name ?? 'Board')}</span>
        </NavLink>
      ))}
    </div>
  );
}
