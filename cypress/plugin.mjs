import { createRequire } from 'node:module';

const autoheal = createRequire(import.meta.url)('./plugin.cjs');
export default autoheal;
export { autoheal };
