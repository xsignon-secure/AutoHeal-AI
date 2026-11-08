/**
 * AutoHeal AI for Cypress, the Node side. In cypress.config.js:
 *
 *   const autoheal = require('xsignon-autoheal/cypress/plugin');
 *   module.exports = defineConfig({
 *     e2e: { setupNodeEvents(on, config) { autoheal(on, config); return config; } },
 *   });
 *
 * (ESM / TypeScript: import autoheal from 'xsignon-autoheal/cypress/plugin'.)
 *
 * It adds two tasks for the support file: one writes what a test saw to
 * cypress/autoheal/<id>.json (keep that folder with your test artifacts), one
 * reads AutoHeal's quarantine list. If you register your own tasks, Cypress
 * merges them with these.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 4 * 1024 * 1024;

function autoheal(on, config) {
  const root = (config && config.projectRoot) || process.cwd();
  const outDir = process.env.AUTOHEAL_DOM_DIR || path.join(root, 'cypress', 'autoheal');
  on('task', {
    'autoheal:save'(data) {
      try {
        if (!data || typeof data.spec !== 'string' || typeof data.title !== 'string') return null;
        const text = JSON.stringify(data);
        if (text.length > MAX_BYTES) return null;
        fs.mkdirSync(outDir, { recursive: true });
        const id = createHash('sha256').update(`${data.spec}\n${data.title}`).digest('hex').slice(0, 16);
        fs.writeFileSync(path.join(outDir, `${id}.json`), text);
      } catch {
        // Recording is a help; never fail the run.
      }
      return null;
    },
    'autoheal:quarantine'() {
      try {
        const q = JSON.parse(fs.readFileSync(path.join(root, 'playwright-quarantine.json'), 'utf8'));
        return Array.isArray(q && q.entries) ? q.entries.filter((e) => e && typeof e.file === 'string' && typeof e.title === 'string' && typeof e.until === 'string') : [];
      } catch {
        return [];
      }
    },
  });
  return config;
}

module.exports = autoheal;
module.exports.autoheal = autoheal;
module.exports.default = autoheal;
