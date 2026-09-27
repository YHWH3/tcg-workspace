import { FileText, Home } from 'lucide-react';
import type { AppModule } from '../types';
import { PageView, PagesHome } from './PageView';
import { PagesTree } from './tree';
import './blocks/media';

export const pagesModule: AppModule = {
  id: 'pages',
  label: 'Pages',
  icon: FileText,
  navItem: { path: '/', label: 'Home', icon: Home },
  routes: [
    { index: true, element: <PagesHome /> },
    { path: 'pages/:pageId', element: <PageView /> },
  ],
  collections: ['pages', 'blocks'],
  sidebarSection: PagesTree,
};
