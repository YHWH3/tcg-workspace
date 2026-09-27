import { pagesModule } from './pages';
import { boardsModule } from './boards';
import { commentsModule } from './comments';
import { activityModule } from './activity';
import type { AppModule } from './types';

export const modules: AppModule[] = [pagesModule, boardsModule, commentsModule, activityModule];
