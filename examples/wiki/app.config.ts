import { defineApp } from '@indx-workspace/app';
import space from './resources/space.ts';
import page from './resources/page.ts';

export default defineApp({
  name: 'wiki',
  resources: [
    space,
    page,
  ],
  recipes: [
  ],
});
