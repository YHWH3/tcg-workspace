import { ClipboardList } from 'lucide-react';
import type { AppModule } from '../types';
import { FormsPage } from './FormsPage';
import { FormEditor } from './FormEditor';
import { FormOperations } from './FormOperations';

export const formsModule: AppModule = {
  id: 'forms',
  label: 'Forms',
  icon: ClipboardList,
  routes: [
    { path: 'forms', element: <FormOperations /> },
    { path: 'forms/:boardId/operations', element: <FormOperations /> },
    { path: 'forms/:boardId/:formId/operations', element: <FormOperations /> },
    { path: 'forms/:boardId', element: <FormsPage /> },
    { path: 'forms/:boardId/:formId', element: <FormEditor /> },
  ],
  collections: ['forms'],
};
