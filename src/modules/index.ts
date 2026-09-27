import { pagesModule } from './pages';
import { tasksModule } from './tasks';
import { commentsModule } from './comments';
import { activityModule } from './activity';
import type { AppModule } from './types';

export const modules: AppModule[] = [pagesModule, tasksModule, commentsModule, activityModule];
