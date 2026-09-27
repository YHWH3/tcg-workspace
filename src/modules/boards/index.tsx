import { KanbanSquare } from 'lucide-react';
import type { AppModule } from '../types';
import { BoardPage, LegacyTaskRedirect } from './BoardPage';
import { BoardsIndex } from './BoardsIndex';
import { MyTasksPage } from './MyTasks';
import { CapturePage } from './Capture';
import { BoardsSection } from './Sidebar';
import './TasksBlock';

export const boardsModule: AppModule = {
  id: 'boards',
  label: 'Boards',
  icon: KanbanSquare,
  navItem: { path: '/boards', label: 'Boards', icon: KanbanSquare },
  routes: [
    { path: 'boards', element: <BoardsIndex /> },
    { path: 'boards/:boardId', element: <BoardPage /> },
    { path: 'boards/:boardId/tasks/:taskId', element: <BoardPage /> },
    { path: 'tasks', element: <MyTasksPage /> },
    { path: 'tasks/:taskId', element: <LegacyTaskRedirect /> },
    { path: 'capture', element: <CapturePage /> },
  ],
  collections: ['tasks', 'boards', 'files'],
  sidebarSection: BoardsSection,
};
