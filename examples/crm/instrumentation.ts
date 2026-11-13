/**
 * Runs once as the server starts. In the image, `aw deploy` sets `AW_APP_MIGRATE_ON_START=1`, so
 * the app applies its migrations to its own schema before it serves, as the role that owns that
 * schema. A failed migration throws and the container exits, so the app never serves an older
 * schema. `aw dev` migrates through `aw-app migrate` and leaves the variable unset.
 *
 * Then, when the app defines recipes, their runner starts after the migration: it resumes what an
 * earlier process left and evaluates the schedules every 30 seconds. It reads the app's machine
 * key besides the variables every handler reads, and names any that is missing.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.AW_APP_MIGRATE_ON_START === '1') {
    const { migrateApp } = await import('@indx-workspace/app/db');
    await migrateApp({
      url: required('DATABASE_URL'),
      appName: required('AW_APP_NAME'),
      migrationsFolder: 'db/migrations',
    });
  }
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { default: app } = await import('./app.config');
    if (app.recipes.length > 0) {
      const { serveRecipes } = await import('@indx-workspace/app/server');
      await serveRecipes(app);
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`AW_APP_MIGRATE_ON_START=1 needs ${name}.`);
  }
  return value;
}
