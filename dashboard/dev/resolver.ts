import { registerHooks } from 'node:module';

/**
 * Lets Node run the API files straight from TypeScript. They import '../lib/x.js' (the form Vercel's
 * build needs), while the files on disk are .ts, so a missing .js import falls back to its .ts twin.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
