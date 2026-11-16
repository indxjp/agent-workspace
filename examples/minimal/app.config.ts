import { defineApp } from '@indx-workspace/app';
import note from './resources/note.ts';

export default defineApp({
  name: 'minimal',
  resources: [
    note,
  ],
  recipes: [
  ],
});
