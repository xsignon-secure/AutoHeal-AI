/**
 * The publish job's view of the code host: GitHub or GitLab, through their
 * REST APIs with plain fetch (no gh CLI, no packages), so the same publish
 * step works in GitHub Actions, GitLab CI and CircleCI.
 *
 * Every call has a timeout and returns plain values; errors carry the HTTP
 * status and the first part of the host's message, never the token.
 */

const TIMEOUT = 30_000;

export class ForgeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function trimSlash(s) {
  let out = s;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

async function request(base, headers, method, route, body, form) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT) };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${trimSlash(base)}${route}`, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && (data.message || data.error || (Array.isArray(data.errors) ? JSON.stringify(data.errors) : ''))) || text;
    throw new ForgeError(`${method} ${route.split('?')[0]}: HTTP ${res.status} ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`, res.status);
  }
  return data;
}

/** GitHub (github.com or GitHub Enterprise Server). */
export function githubForge({ api, server, repo, token }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ForgeError('GitHub repository (owner/name) is unknown; set AUTOHEAL_REPO');
  if (!token) throw new ForgeError('No GitHub token: set GH_TOKEN, GITHUB_TOKEN or AUTOHEAL_GITHUB_TOKEN (contents, pull-requests and issues write)');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'autoheal-ai' };
  const call = (method, route, body) => request(api, headers, method, route, body);
  const r = `/repos/${repo}`;
  const owner = repo.split('/')[0];
  return {
    name: 'github',
    label: 'pull request',
    server,
    repo,
    pushUrl: `${trimSlash(server)}/${repo}.git`,
    pushHeader: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    async findPr(branch) {
      const list = await call('GET', `${r}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`);
      const pr = Array.isArray(list) ? list[0] : null;
      return pr ? { url: pr.html_url, number: pr.number } : null;
    },
    async createPr({ base, head, title, body, draft }) {
      const pr = await call('POST', `${r}/pulls`, { base, head, title, body, draft: !!draft });
      return { url: pr.html_url, number: pr.number };
    },
    async editPr(pr, body) {
      await call('PATCH', `${r}/pulls/${pr.number}`, { body });
    },
    async openIssues() {
      const list = await call('GET', `${r}/issues?state=open&per_page=100`);
      return (Array.isArray(list) ? list : []).filter((i) => !i.pull_request && typeof i.title === 'string' && i.title.startsWith('AutoHeal')).map((i) => ({ title: i.title, url: i.html_url, number: i.number }));
    },
    async createIssue(title, body) {
      const i = await call('POST', `${r}/issues`, { title, body });
      return { url: i.html_url, number: i.number };
    },
    async commentIssue(issue, body) {
      await call('POST', `${r}/issues/${issue.number}/comments`, { body });
    },
    async commentPr(number, body) {
      await call('POST', `${r}/issues/${number}/comments`, { body });
    },
    async commentCommit(sha, body) {
      await call('POST', `${r}/commits/${sha}/comments`, { body });
    },
    /** Starts a workflow on a branch. The default GITHUB_TOKEN may do this, so CI runs on the fix PR without a personal token. */
    async dispatch(workflow, ref) {
      await call('POST', `${r}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref });
    },
    imageUrl(sha, file) {
      return `${trimSlash(server)}/${repo}/blob/${sha}/${file}?raw=true`;
    },
  };
}

/** GitLab (gitlab.com or self-managed). */
export function gitlabForge({ api, server, repo, projectId, token }) {
  if (!projectId && !repo) throw new ForgeError('GitLab project is unknown; set AUTOHEAL_REPO (group/name)');
  if (!token) throw new ForgeError('No GitLab token: set AUTOHEAL_GITLAB_TOKEN to a project access token with the api and write_repository scopes (Developer role)');
  const headers = { 'private-token': token, 'user-agent': 'autoheal-ai' };
  const call = (method, route, body, form) => request(api, headers, method, route, body, form);
  const p = `/projects/${projectId ?? encodeURIComponent(repo)}`;
  return {
    name: 'gitlab',
    label: 'merge request',
    server,
    repo,
    pushUrl: `${trimSlash(server)}/${repo}.git`,
    pushHeader: `AUTHORIZATION: basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
    async findPr(branch) {
      const list = await call('GET', `${p}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=5`);
      const mr = Array.isArray(list) ? list[0] : null;
      return mr ? { url: mr.web_url, number: mr.iid } : null;
    },
    async createPr({ base, head, title, body, draft }) {
      const mr = await call('POST', `${p}/merge_requests`, { source_branch: head, target_branch: base, title: draft ? `Draft: ${title}` : title, description: body, remove_source_branch: true });
      return { url: mr.web_url, number: mr.iid };
    },
    async editPr(mr, body) {
      await call('PUT', `${p}/merge_requests/${mr.number}`, { description: body });
    },
    async openIssues() {
      const list = await call('GET', `${p}/issues?state=opened&in=title&search=AutoHeal&per_page=100`);
      return (Array.isArray(list) ? list : []).filter((i) => typeof i.title === 'string' && i.title.startsWith('AutoHeal')).map((i) => ({ title: i.title, url: i.web_url, number: i.iid }));
    },
    async createIssue(title, body) {
      const i = await call('POST', `${p}/issues`, { title, description: body });
      return { url: i.web_url, number: i.iid };
    },
    async commentIssue(issue, body) {
      await call('POST', `${p}/issues/${issue.number}/notes`, { body });
    },
    async commentPr(number, body) {
      await call('POST', `${p}/merge_requests/${number}/notes`, { body });
    },
    async commentCommit(sha, body) {
      await call('POST', `${p}/repository/commits/${sha}/comments`, { note: body });
    },
    /** Uploads an image to the project and returns its Markdown link. */
    async uploadImage(name, buffer, type) {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type }), name);
      const res = await call('POST', `${p}/uploads`, undefined, form);
      if (!res || typeof res.url !== 'string') throw new ForgeError('GitLab upload returned no url');
      // full_path is absolute on the server; url is relative to the project.
      return typeof res.full_path === 'string' && res.full_path.startsWith('/') ? `${trimSlash(server)}${res.full_path}` : `${trimSlash(server)}/${repo}${res.url}`;
    },
  };
}

/** The forge for this run, from the CI info (src/ci.ts) and the environment's tokens. */
export function forgeFor(info, env = process.env) {
  let forge;
  if (info.forge === 'github') {
    forge = githubForge({ api: info.api, server: info.server, repo: info.repo, token: env.AUTOHEAL_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN });
  } else if (info.forge === 'gitlab') {
    forge = gitlabForge({ api: info.api, server: info.server, repo: info.repo, projectId: info.projectId, token: env.AUTOHEAL_GITLAB_TOKEN || env.GITLAB_TOKEN });
  }
  // A different git URL to push to (a mirror, or a local bare repository in tests).
  if (forge && env.AUTOHEAL_PUSH_URL) forge.pushUrl = env.AUTOHEAL_PUSH_URL;
  if (forge) return forge;
  throw new ForgeError('AutoHeal can open fixes on GitHub and GitLab. This repository\'s host is unknown: set AUTOHEAL_FORGE=github or gitlab, and AUTOHEAL_SERVER_URL if it is self-hosted');
}
