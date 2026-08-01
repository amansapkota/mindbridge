/**
 * Loads server/.env regardless of where node was launched from, so `npm start`,
 * `node seed.js` and an editor's run button all see the same configuration.
 *
 * Imported for side effects by every entry point that reads process.env at
 * module scope (db.js, ai.js), which is why it is its own module rather than a
 * line at the top of index.js — ESM evaluates imports before the importing
 * module's body, so a bare dotenv call in index.js would run too late.
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(dir, ".env"), quiet: true });
