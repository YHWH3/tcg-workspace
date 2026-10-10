import { pagesModule } from './pages';
import { boardsModule } from './boards';
import { moodboardsModule } from './moodboards';
import { commentsModule } from './comments';
import { activityModule } from './activity';
import { inboxModule } from './inbox';
import { formsModule } from './forms';
import { automationsModule } from './automations';
import type { AppModule } from './types';

export const modules: AppModule[] = [pagesModule, boardsModule, moodboardsModule, commentsModule, activityModule, inboxModule, formsModule, automationsModule];
