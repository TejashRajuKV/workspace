import crypto from "node:crypto";

const API = "https://api.github.com";
const USER_AGENT = "infinite-workspace";

export class GithubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

function detail(data) {
  if (!data) return "";
  if (Array.isArray(data.errors) && data.errors[0]?.message) return ` (${data.errors[0].message})`;
  return "";
}

function messageFor(status, data) {
  const msg = typeof data?.message === "string" ? data.message : "";
  if (status === 401) return "GitHub rejected the token. Create a token with Contents read/write access.";
  if (status === 403) {
    if (/rate limit/i.test(msg)) return "GitHub rate limit reached. Try again in a few minutes.";
    return "GitHub denied access. Check the token's repository permissions (Contents: read and write).";
  }
  if (status === 404) return "Repository not found, or the token cannot access it.";
  if (status === 409) return msg || "GitHub reported a conflict.";
  if (status === 422) return (msg || "GitHub could not accept this repository or branch.") + detail(data);
  return msg || `GitHub API error (${status})`;
}

async function request(token, route, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new GithubError("Could not reach GitHub. Check the server's network connection.", 502);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new GithubError(messageFor(res.status, data), res.status);
  return data;
}

async function getOrNull(token, route) {
  try {
    return await request(token, route);
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return null;
    throw err;
  }
}

export async function getViewer(token) {
  const user = await request(token, "/user");
  return { login: user.login, name: user.name || user.login };
}

export async function getRepo(token, owner, repo) {
  return getOrNull(token, `/repos/${owner}/${repo}`);
}

export async function createRepo(token, name, isPrivate) {
  return request(token, "/user/repos", {
    method: "POST",
    body: {
      name,
      private: !!isPrivate,
      auto_init: false,
      description: "Created from Infinite Workspace",
    },
  });
}

export function isValidBranch(branch) {
  if (typeof branch !== "string" || !branch || branch.length > 200) return false;
  if (branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.endsWith(".") || branch.endsWith(".lock")) return false;
  if (branch.includes("..") || branch.includes("//")) return false;
  if (/[\s~^:?*[\\]/.test(branch)) return false;
  for (const ch of branch) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

export function isValidRepoPart(value, max = 100) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

export function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export async function getBranches(token, owner, repo) {
  const data = await request(token, `/repos/${owner}/${repo}/branches?per_page=100`);
  return (data || []).map((b) => b.name).filter(Boolean);
}

async function remoteSnapshot(token, owner, repo, branch) {
  const ref = await getOrNull(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (!ref?.object?.sha) {
    throw new GithubError(`Branch "${branch}" was not found in this repository.`, 404);
  }
  const headSha = ref.object.sha;
  const commit = await request(token, `/repos/${owner}/${repo}/git/commits/${headSha}`);
  const tree = await request(
    token,
    `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`
  );
  if (tree?.truncated) throw new GithubError("Repository tree is too large to sync.", 413);
  const files = new Map();
  for (const item of tree?.tree || []) {
    if (item.type === "blob") files.set(item.path, { sha: item.sha, size: item.size || 0 });
  }
  return { headSha, files };
}

export async function diffWorkspace({ token, owner, repo, branch, files }) {
  const remote = await remoteSnapshot(token, owner, repo, branch);
  const local = new Map();
  for (const file of files || []) {
    local.set(file.path, gitBlobSha(file.content));
  }
  const added = [];
  const modified = [];
  const deleted = [];
  let unchanged = 0;
  for (const [path, info] of remote.files) {
    if (!local.has(path)) added.push(path);
    else if (local.get(path) !== info.sha) modified.push(path);
    else unchanged++;
  }
  for (const path of local.keys()) {
    if (!remote.files.has(path)) deleted.push(path);
  }
  const cap = 500;
  return {
    branch,
    headSha: remote.headSha,
    counts: { added: added.length, modified: modified.length, deleted: deleted.length, unchanged },
    added: added.slice(0, cap),
    modified: modified.slice(0, cap),
    deleted: deleted.slice(0, cap),
    truncated: added.length > cap || modified.length > cap || deleted.length > cap,
  };
}

export async function fetchRemoteFiles({ token, owner, repo, branch, paths, replaceAll = false }) {
  const remote = await remoteSnapshot(token, owner, repo, branch);
  const wanted = replaceAll ? [...remote.files.keys()] : paths || [];
  if (wanted.length > 2000) throw new GithubError("Too many files to pull (max 2000).", 413);
  const files = [];
  let total = 0;
  for (const path of wanted) {
    const info = remote.files.get(path);
    if (!info) continue;
    if (info.size > 512 * 1024) continue;
    const blob = await request(token, `/repos/${owner}/${repo}/git/blobs/${info.sha}`);
    const data = Buffer.from(String(blob?.content || ""), "base64");
    total += data.length;
    if (total > 25 * 1024 * 1024) throw new GithubError("Remote files are too large to pull (25MB max).", 413);
    if (data.includes(0)) continue;
    files.push({ path, content: data.toString("utf8") });
  }
  return {
    headSha: remote.headSha,
    files,
    skipped: wanted.length - files.length,
    allPaths: [...remote.files.keys()],
  };
}

export async function pushWorkspace({ token, owner, repo, branch, files, message, prune }) {
  const repoInfo = await getRepo(token, owner, repo);
  if (!repoInfo) throw new GithubError("Repository not found, or the token cannot access it.", 404);

  const branchRef = await getOrNull(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  let parentSha = branchRef?.object?.sha || null;
  if (!parentSha && repoInfo.default_branch && repoInfo.default_branch !== branch) {
    const fallback = await getOrNull(
      token,
      `/repos/${owner}/${repo}/git/ref/heads/${repoInfo.default_branch}`
    );
    parentSha = fallback?.object?.sha || null;
  }

  let baseTreeSha = null;
  const existing = new Map();
  if (parentSha) {
    const commit = await request(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
    baseTreeSha = commit?.tree?.sha || null;
    if (baseTreeSha) {
      const tree = await request(
        token,
        `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`
      );
      if (tree?.truncated) {
        throw new GithubError("Repository tree is too large to sync.", 413);
      }
      for (const item of tree?.tree || []) {
        if (item.type === "blob") existing.set(item.path, item.sha);
      }
    }
  }

  const seen = new Set();
  const treeEntries = [];
  let uploaded = 0;
  for (const file of files || []) {
    const path = String(file.path || "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const content = String(file.content ?? "");
    const sha = gitBlobSha(content);
    if (!existing.has(path) || existing.get(path) !== sha) {
      const blob = await request(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: { content, encoding: "utf-8" },
      });
      treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
      uploaded++;
    } else {
      treeEntries.push({ path, mode: "100644", type: "blob", sha });
    }
  }

  let removed = 0;
  if (prune) {
    for (const path of existing.keys()) {
      if (seen.has(path)) continue;
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
      removed++;
    }
  }

  if (branchRef && uploaded === 0 && removed === 0) {
    return {
      unchanged: true,
      branch,
      commitSha: parentSha,
      url: parentSha ? `https://github.com/${owner}/${repo}/commit/${parentSha}` : null,
      uploaded: 0,
      removed: 0,
      total: seen.size,
    };
  }

  const tree = await request(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: baseTreeSha ? { base_tree: baseTreeSha, tree: treeEntries } : { tree: treeEntries },
  });
  const commitBody = {
    message: String(message || "").trim().slice(0, 500) || "Update from Infinite Workspace",
    tree: tree.sha,
  };
  if (parentSha) commitBody.parents = [parentSha];
  const commit = await request(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: commitBody,
  });

  if (branchRef) {
    await request(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: { sha: commit.sha, force: false },
    });
  } else {
    await request(token, `/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  return {
    unchanged: false,
    branch,
    commitSha: commit.sha,
    url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    uploaded,
    removed,
    total: seen.size,
  };
}

export async function createPull({ token, owner, repo, title, body, head, base }) {
  const data = await request(token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: { title, body: body || "", head, base },
  });
  return {
    number: data?.number,
    url: data?.html_url,
    state: data?.state,
    head: data?.head?.ref,
    base: data?.base?.ref,
  };
}
