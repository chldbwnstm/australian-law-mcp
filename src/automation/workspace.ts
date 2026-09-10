import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { assertAllowedPath, Config, PolicyError, safePath } from "./config.js"
import { cleanEnvironment, runProcess } from "./process.js"
import type { Run } from "./state.js"
import type { Role } from "./sandbox.js"

export interface Workspaces {
  prepare(run: Run): Promise<void>
  snapshot(run: Run, role: Role): Promise<string>
  commit(run: Run, directory: string): Promise<string>
  recoveredCommit(run: Run): Promise<string | undefined>
  push(run: Run): Promise<void>
}
interface Entry { hash: string; executable: boolean }
const ignoredOutputs = new Set(["node_modules", "build", "build-automation", "coverage", ".vitest"])
export function scanFiles(root: string, config: Config): Map<string, Entry> {
  const files = new Map<string, Entry>()
  let bytes = 0, entries = 0
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > config.maxSnapshotFiles * 4) throw new PolicyError("Too many workspace entries")
      if (!prefix && ignoredOutputs.has(entry.name)) continue
      const path = prefix + entry.name
      if (!safePath.safeParse(path).success) throw new PolicyError("Unsafe workspace path")
      const absolute = join(directory, entry.name)
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.nlink > 1 && stat.isFile()) {
        throw new PolicyError("Links and special files are forbidden: " + path)
      }
      if (stat.isDirectory()) walk(absolute, path + "/")
      else {
        bytes += stat.size
        if (bytes > config.maxSnapshotBytes || files.size >= config.maxSnapshotFiles) throw new PolicyError("Workspace size limit exceeded")
        files.set(path, { hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"), executable: (stat.mode & 0o111) !== 0 })
      }
    }
  }
  walk(root, "")
  return files
}
export class GitWorkspaces implements Workspaces {
  constructor(private config: Config, private token: string) {}
  private paths(run: Run) {
    return { repo: join(this.config.stateDir, "repos", run.id + ".git"), tree: join(this.config.stateDir, "worktrees", run.id) }
  }
  private async git(args: string[], cwd: string, authenticated = false) {
    const env: NodeJS.ProcessEnv = {
      ...cleanEnvironment(), HOME: join(this.config.stateDir, "empty-home"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Issue Agent", GIT_AUTHOR_EMAIL: "issue-agent@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Issue Agent", GIT_COMMITTER_EMAIL: "issue-agent@users.noreply.github.com",
    }
    if (authenticated) {
      env.GIT_CONFIG_COUNT = "1"
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader"
      env.GIT_CONFIG_VALUE_0 = "Authorization: Basic " + Buffer.from("x-access-token:" + this.token).toString("base64")
    }
    return runProcess(this.config.gitExecutable,
      ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "commit.gpgsign=false",
        "-c", "core.autocrlf=false", "-c", "protocol.file.allow=never", ...args],
      { cwd, env, timeoutMs: 120_000, maxOutputBytes: this.config.maxSnapshotBytes })
  }
  private remote(): string { return "https://github.com/" + this.config.owner + "/" + this.config.repo + ".git" }
  async prepare(run: Run): Promise<void> {
    if (!run.baseSha) throw new PolicyError("Missing approved base commit")
    const { repo, tree } = this.paths(run)
    mkdirSync(dirname(repo), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(tree), { recursive: true, mode: 0o700 })
    if (!existsSync(repo)) await this.git(["init", "--bare", repo], this.config.stateDir)
    if (!existsSync(tree)) {
      await this.git(["--git-dir", repo, "fetch", "--no-tags", this.remote(), run.baseSha], this.config.stateDir, true)
      // Detached construction avoids a partially-created branch on recovery.
      await this.git(["--git-dir", repo, "worktree", "add", "--detach", tree, run.baseSha], this.config.stateDir)
    }
    // Only the daemon's private worktree is reset. A crashed copy/stage operation
    // must not become the starting point of a later implementation attempt.
    await this.git(["reset", "--hard", run.headSha ?? run.baseSha], tree)
    await this.git(["clean", "-fdx"], tree)
  }
  async snapshot(run: Run, role: Role): Promise<string> {
    const directory = join(this.config.stateDir, "scratch", run.id + "-" + role)
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Grok triages the issue only. It never sees source code or host files.
    if (role === "grok") return directory
    const { tree } = this.paths(run)
    const listing = (await this.git(["ls-files", "-z"], tree)).stdout.split("\0").filter(Boolean)
    let total = 0
    if (listing.length > this.config.maxSnapshotFiles) throw new PolicyError("Too many tracked files")
    for (const path of listing) {
      if (!safePath.safeParse(path).success) throw new PolicyError("Unsafe tracked path")
      // Check every parent, not just the leaf, before reading a tracked file.
      let parent = tree
      for (const part of path.split("/")) {
        parent = join(parent, part)
        if (lstatSync(parent).isSymbolicLink()) throw new PolicyError("Tracked symlink is unsupported")
      }
      const source = join(tree, path), destination = join(directory, path)
      const info = lstatSync(source)
      total += info.size
      if (!info.isFile() || info.nlink > 1 || total > this.config.maxSnapshotBytes) throw new PolicyError("Unsupported or oversized repository snapshot")
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
      chmodSync(destination, (info.mode & 0o111) ? 0o755 : 0o644)
    }
    return directory
  }
  private message(run: Run): string { return "Issue Agent " + run.id + " attempt " + run.attempts }
  async recoveredCommit(run: Run): Promise<string | undefined> {
    const { tree } = this.paths(run)
    if (!existsSync(tree)) return undefined
    const subject = (await this.git(["log", "-1", "--format=%s"], tree)).stdout.trim()
    if (subject !== this.message(run)) return undefined
    const head = (await this.git(["rev-parse", "HEAD"], tree)).stdout.trim()
    const previous = run.headSha ?? run.baseSha
    if (head === previous) return undefined
    const parent = (await this.git(["rev-parse", "HEAD^"], tree)).stdout.trim()
    if (parent !== previous) throw new PolicyError("Recovered commit has an unexpected parent")
    return head
  }
  async commit(run: Run, directory: string): Promise<string> {
    if (!run.design) throw new PolicyError("No validated design")
    const { tree } = this.paths(run)
    // The worker is stopped before inspection. Compare against a fresh trusted
    // export, validate the complete change set, then copy only approved files.
    const baselineDirectory = await this.snapshot(run, "fable")
    const baseline = scanFiles(baselineDirectory, this.config), output = scanFiles(directory, this.config)
    const changed = [...new Set([...baseline.keys(), ...output.keys()])].filter(p =>
      baseline.get(p)?.hash !== output.get(p)?.hash || baseline.get(p)?.executable !== output.get(p)?.executable)
    if (!changed.length || changed.length > this.config.maxChangedFiles) throw new PolicyError("Empty or oversized implementation diff")
    for (const path of changed) assertAllowedPath(path, this.config, run.design)
    for (const path of changed) {
      const destination = join(tree, path)
      if (!output.has(path)) rmSync(destination)
      else {
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(join(directory, path), destination)
        chmodSync(destination, output.get(path)!.executable ? 0o755 : 0o644)
      }
    }
    await this.git(["add", "--all", "--", ...changed], tree)
    // Validate what Git will actually commit as a second boundary.
    const staged = (await this.git(["diff", "--cached", "--no-renames", "--name-only", "-z"], tree)).stdout.split("\0").filter(Boolean)
    if (staged.length > this.config.maxChangedFiles) throw new PolicyError("Staged diff exceeds file budget")
    for (const path of staged) assertAllowedPath(path, this.config, run.design)
    await this.git(["commit", "-m", this.message(run)], tree)
    return (await this.git(["rev-parse", "HEAD"], tree)).stdout.trim()
  }
  async push(run: Run): Promise<void> {
    if (!run.headSha) throw new PolicyError("No implementation commit")
    await this.git(["push", this.remote(), run.headSha + ":refs/heads/" + run.branch], this.paths(run).tree, true)
  }
}
