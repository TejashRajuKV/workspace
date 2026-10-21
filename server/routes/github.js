import { db } from "../lib/db.js";
import { fail, json, readJson } from "../lib/http.js";
import { requireMember } from "../lib/apiHelpers.js";
import { validateFilePath } from "../../src/shared/protocol.js";
import { sealToken, openToken } from "../lib/secrets.js";
import { importFiles } from "../lib/importer.js";
import { serviceClient } from "../lib/serviceClient.js";
import { dispatchEvent } from "../lib/automation.js";
import {
  createPull,
  createRepo,
  diffWorkspace,
  fetchRemoteFiles,
  getBranches,
  getRepo,
  getViewer,
  isValidBranch,
  isValidRepoPart,
  pushWorkspace,
} from "../lib/github.js";

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function httpError(err) {
  if (err && typeof err.status === "number" && typeof err.message === "string") {
    return fail(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
  }
  return err;
}

function statusPayload(link) {
  if (!link) return { connected: false };
  return {
    connected: true,
    owner: link.owner,
    repo: link.repo,
    branch: link.branch,
    repoUrl: `https://github.com/${link.owner}/${link.repo}`,
    lastCommitSha: link.lastCommitSha || "",
    lastPushedAt: Number(link.lastPushedAt || 0),
  };
}

function requireOwner(ctx) {
  if (ctx.role !== "owner") {
    throw fail("Only the workspace owner can manage GitHub sync", 403);
  }
}

export function registerGithubRoutes(router) {
  router.get("/api/workspaces/:id/github", async (req, res, { params }) => {
    await requireMember(req, params.id);
    const link = await db.githubLink.findUnique({ where: { workspaceId: params.id } });
    return json(res, statusPayload(link));
  });

  router.put("/api/workspaces/:id/github", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);

    const body = await readJson(req);
    const token = String(body.token || "").trim();
    const owner = String(body.owner || "").trim();
    const repo = String(body.repo || "").trim();
    const branchInput = String(body.branch || "").trim();
    const createMissing = !!body.createRepo;
    const isPrivate = body.private !== false;

    if (token.length < 8 || token.length > 500 || /\s/.test(token)) {
      throw fail("Enter a valid GitHub access token");
    }
    if (!isValidRepoPart(owner) || !isValidRepoPart(repo)) {
      throw fail("Enter a valid GitHub owner and repository name");
    }
    if (branchInput && !isValidBranch(branchInput)) {
      throw fail("Invalid branch name");
    }

    try {
      const viewer = await getViewer(token);
      let info = await getRepo(token, owner, repo);
      if (!info) {
        if (!createMissing) {
          throw fail("Repository not found, or the token cannot access it", 404);
        }
        if (owner.toLowerCase() !== viewer.login.toLowerCase()) {
          throw fail("You can only create a repository under your own GitHub account", 400);
        }
        info = await createRepo(token, repo, isPrivate);
      }

      const branch = branchInput || info.default_branch || "main";
      if (!isValidBranch(branch)) throw fail("Invalid branch name");
      const actualOwner = info.owner?.login || owner;
      const actualRepo = info.name || repo;
      const now = BigInt(Date.now());
      const encrypted = sealToken(token);

      const link = await db.githubLink.upsert({
        where: { workspaceId: id },
        create: {
          workspaceId: id,
          owner: actualOwner,
          repo: actualRepo,
          branch,
          ...encrypted,
          lastCommitSha: "",
          lastPushedAt: BigInt(0),
          createdAt: now,
          updatedAt: now,
        },
        update: {
          owner: actualOwner,
          repo: actualRepo,
          branch,
          ...encrypted,
          lastCommitSha: "",
          lastPushedAt: BigInt(0),
          updatedAt: now,
        },
      });

      return json(res, { ...statusPayload(link), viewer: viewer.login });
    } catch (err) {
      throw httpError(err);
    }
  });

  router.delete("/api/workspaces/:id/github", async (req, res, { params }) => {
    const ctx = await requireMember(req, params.id, true);
    requireOwner(ctx);
    await db.githubLink.deleteMany({ where: { workspaceId: params.id } });
    return json(res, { ok: true });
  });

  router.post("/api/workspaces/:id/github/push", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);

    const body = await readJson(req);
    const link = await db.githubLink.findUnique({ where: { workspaceId: id } });
    if (!link) throw fail("Connect a GitHub repository first", 400);

    const token = openToken(link);
    if (!token) throw fail("Stored GitHub token could not be read. Reconnect the repository.", 400);

    const targetBranch = String(body.branch || link.branch);
    if (!isValidBranch(targetBranch)) throw fail("Invalid branch name");

    const docs = await db.document.findMany({
      where: { workspaceId: id, deleted: false, isFolder: false },
      orderBy: { path: "asc" },
    });
    if (docs.length > MAX_FILES) throw fail("Workspace has too many files to push", 413);
    let total = 0;
    const files = [];
    for (const doc of docs) {
      if (validateFilePath(doc.path)) throw fail(`Invalid file path: ${doc.path}`, 400);
      total += Buffer.byteLength(doc.content, "utf8");
      if (total > MAX_TOTAL_BYTES) throw fail("Workspace is too large to push (25MB max)", 413);
      files.push({ path: doc.path, content: doc.content });
    }

    try {
      const result = await pushWorkspace({
        token,
        owner: link.owner,
        repo: link.repo,
        branch: targetBranch,
        files,
        message: body.message,
        prune: body.prune === true,
      });
      await db.githubLink.update({
        where: { workspaceId: id },
        data: {
          branch: targetBranch,
          lastCommitSha: result.commitSha || link.lastCommitSha,
          lastPushedAt: BigInt(Date.now()),
          updatedAt: BigInt(Date.now()),
        },
      });
      dispatchEvent({
        workspaceId: id,
        event: "github.push",
        actorId: ctx.user.id,
        payload: { branch: targetBranch, commitSha: result.commitSha },
      }).catch(() => {});
      return json(res, {
        ...result,
        branch: targetBranch,
        repoUrl: `https://github.com/${link.owner}/${link.repo}`,
      });
    } catch (err) {
      throw httpError(err);
    }
  });

  router.get("/api/workspaces/:id/github/branches", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);
    const link = await db.githubLink.findUnique({ where: { workspaceId: id } });
    if (!link) throw fail("Connect a GitHub repository first", 400);
    const token = openToken(link);
    if (!token) throw fail("Stored GitHub token could not be read. Reconnect the repository.", 400);
    try {
      const branches = await getBranches(token, link.owner, link.repo);
      return json(res, { branches, current: link.branch });
    } catch (err) {
      throw httpError(err);
    }
  });

  router.post("/api/workspaces/:id/github/preview", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);
    const link = await db.githubLink.findUnique({ where: { workspaceId: id } });
    if (!link) throw fail("Connect a GitHub repository first", 400);
    const token = openToken(link);
    if (!token) throw fail("Stored GitHub token could not be read. Reconnect the repository.", 400);

    const body = await readJson(req);
    const branch = String(body.branch || link.branch);
    if (!isValidBranch(branch)) throw fail("Invalid branch name");
    const includeContent = body.includeContent === true;
    const files = await loadLocalFiles(id);
    try {
      const diff = await diffWorkspace({ token, owner: link.owner, repo: link.repo, branch, files });
      let fileDiffs = null;
      if (includeContent) {
        const wanted = diff.added.concat(diff.modified).slice(0, 200);
        const remote = await fetchRemoteFiles({
          token,
          owner: link.owner,
          repo: link.repo,
          branch,
          paths: wanted,
        });
        const remoteMap = Object.fromEntries(remote.files.map((f) => [f.path, f.content]));
        const localMap = Object.fromEntries(files.map((f) => [f.path, f.content]));
        fileDiffs = wanted.map((p) => ({
          path: p,
          remote: remoteMap[p] ?? null,
          local: localMap[p] ?? null,
        }));
      }
      return json(res, {
        ...diff,
        fileDiffs,
        repoUrl: `https://github.com/${link.owner}/${link.repo}`,
      });
    } catch (err) {
      throw httpError(err);
    }
  });

  // POST /api/workspaces/:id/github/pr { title, body, base?, head? }
  router.post("/api/workspaces/:id/github/pr", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);
    const link = await db.githubLink.findUnique({ where: { workspaceId: id } });
    if (!link) throw fail("Connect a GitHub repository first", 400);
    const token = openToken(link);
    if (!token) throw fail("Stored GitHub token could not be read. Reconnect the repository.", 400);

    const body = await readJson(req);
    const title = String(body.title || "").trim();
    if (!title || title.length > 256) throw fail("Title must be 1-256 characters");
    const head = String(body.head || link.branch);
    const base = String(body.base || "").trim();
    if (!isValidBranch(head)) throw fail("Invalid head branch");
    if (base && !isValidBranch(base)) throw fail("Invalid base branch");

    try {
      const repoInfo = await getRepo(token, link.owner, link.repo);
      const resolvedBase = base || repoInfo?.default_branch || "main";
      const pull = await createPull({
        token,
        owner: link.owner,
        repo: link.repo,
        title,
        body: String(body.body || "").slice(0, 20000),
        head,
        base: resolvedBase,
      });
      return json(res, { pull }, 201);
    } catch (err) {
      throw httpError(err);
    }
  });

  router.post("/api/workspaces/:id/github/pull", async (req, res, { params }) => {
    const id = params.id;
    const ctx = await requireMember(req, id, true);
    requireOwner(ctx);
    const link = await db.githubLink.findUnique({ where: { workspaceId: id } });
    if (!link) throw fail("Connect a GitHub repository first", 400);
    const token = openToken(link);
    if (!token) throw fail("Stored GitHub token could not be read. Reconnect the repository.", 400);

    const body = await readJson(req);
    const mode = body.mode === "replace" ? "replace" : "merge";
    const policy = mode === "replace" ? "overwrite" : body.policy === "rename" ? "rename" : "overwrite";
    const branch = String(body.branch || link.branch);
    if (!isValidBranch(branch)) throw fail("Invalid branch name");

    try {
      const diff = await diffWorkspace({
        token,
        owner: link.owner,
        repo: link.repo,
        branch,
        files: await loadLocalFiles(id),
      });
      const wanted = diff.added.concat(diff.modified);
      if (mode === "merge" && diff.truncated) {
        throw fail("Too many remote changes to merge at once — use Replace mode", 409);
      }
      const remote = await fetchRemoteFiles({
        token,
        owner: link.owner,
        repo: link.repo,
        branch,
        paths: wanted,
        replaceAll: mode === "replace",
      });
      const summary = await importFiles(id, remote.files, { policy, userId: ctx.user.id });

      let removed = 0;
      if (mode === "replace") {
        const keep = new Set(remote.allPaths);
        const localDocs = await db.document.findMany({
          where: { workspaceId: id, deleted: false, isFolder: false },
          select: { id: true, path: true },
        });
        for (const doc of localDocs) {
          if (!keep.has(doc.path) && doc.path.includes(".")) {
            await db.document.update({
              where: { id: doc.id },
              data: { deleted: true, deletedAt: BigInt(Date.now()) },
            });
            removed++;
          }
        }
      }

      await db.githubLink.update({
        where: { workspaceId: id },
        data: {
          branch,
          lastCommitSha: remote.headSha,
          updatedAt: BigInt(Date.now()),
        },
      });
      serviceClient.notifyFsChanged(id, "pulled").catch(() => {});
      dispatchEvent({
        workspaceId: id,
        event: "github.pull",
        actorId: ctx.user.id,
        payload: { branch, mode, counts: diff.counts },
      }).catch(() => {});
      return json(res, {
        ok: true,
        mode,
        branch,
        headSha: remote.headSha,
        diff: diff.counts,
        summary,
        removed,
        skipped: remote.skipped,
      });
    } catch (err) {
      throw httpError(err);
    }
  });
}

async function loadLocalFiles(workspaceId) {
  const docs = await db.document.findMany({
    where: { workspaceId, deleted: false, isFolder: false },
    orderBy: { path: "asc" },
  });
  if (docs.length > MAX_FILES) throw fail("Workspace has too many files to sync", 413);
  const files = [];
  let total = 0;
  for (const doc of docs) {
    if (validateFilePath(doc.path)) throw fail(`Invalid file path: ${doc.path}`, 400);
    total += Buffer.byteLength(doc.content, "utf8");
    if (total > MAX_TOTAL_BYTES) throw fail("Workspace is too large to sync (25MB max)", 413);
    files.push({ path: doc.path, content: doc.content });
  }
  return files;
}
