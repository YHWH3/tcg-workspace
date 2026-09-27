import { CheckSquare } from 'lucide-react';
import type { AppModule } from '../types';
import { TasksPage } from './TasksPage';

export const tasksModule: AppModule = {
  id: 'tasks',
  label: 'Tasks',
  icon: CheckSquare,
  navItem: { path: '/tasks', label: 'Tasks', icon: CheckSquare },
  routes: [
    { path: 'tasks', element: <TasksPage /> },
    { path: 'tasks/:taskId', element: <TasksPage /> },
  ],
  collections: ['tasks'],
};
