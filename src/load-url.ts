// Loads a chunk by URL. Kept out of the minified core (esbuild.config.mjs writes dist/load-url.js
// verbatim) because minifying strips the comments that make webpack and Vite leave the import alone.
export const loadUrl = (u: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ u);
