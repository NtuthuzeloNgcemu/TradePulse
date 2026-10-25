# Vendored libraries

Exact copies, served from this site instead of a CDN so the app doesn't depend on a third party at runtime and can't receive an unexpected version.

| File | Package | Version | Licence |
|---|---|---|---|
| `supabase-js-2.117.3.js` | `@supabase/supabase-js` (`dist/umd/supabase.js`) | 2.117.3 | MIT |
| `papaparse-5.4.1.min.js` | `papaparse` (`papaparse.min.js`) | 5.4.1 | MIT |

To upgrade, replace the file with the same file from the new npm package version, rename it, update the `<script>` tags, and run the tests and a manual login check.
