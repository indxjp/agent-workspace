import { defineApp } from '@indx-workspace/app';
import company from './resources/company.ts';
import contact from './resources/contact.ts';
import deal from './resources/deal.ts';
import enrichContactRecipe from './recipes/enrich-contact.ts';

export default defineApp({
  name: 'crm',
  resources: [
    company,
    contact,
    deal,
  ],
  recipes: [
    enrichContactRecipe,
  ],
});
