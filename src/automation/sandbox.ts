import { join } from "node:path"
import { Config, PolicyError } from "./config.js"
import { cleanEnvironment, runProcess } from "./process.js"

export type Role = "grok" | "fable" | "opus"
export interface Worker {
  run(role: Role, runId: string, directory: string, prompt: string, signal?: AbortSignal): Promise<string>
  recover(runId: string): Promise<void>
}
export function workerEnvironment(config: Config, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = cleanEnvironment()
  env.DOCKER_CONFIG = join(config.stateDir, "docker-client")
  for (const name of config.sandbox.secretNames) {
    const value = source[name]
    if (!value) throw new PolicyError("Missing configured worker credential: " + name)
    env[name] = value
  }
  return env
}
export function containerName(runId: string, role: Role): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new PolicyError("Invalid container run ID")
  return "issue-agent-" + runId + "-" + role
}
export function dockerArguments(config: Config, role: Role, runId: string, directory: string, uid: number, gid: number): string[] {
  if (uid <= 0 || gid < 0 || /[\x00-\x1f,]/.test(directory) || !directory.startsWith("/")) throw new PolicyError("Invalid sandbox mount or user")
  const sandbox = config.sandbox
  return ["run", "--rm", "--pull=never", "--init", "--interactive",
    "--name", containerName(runId, role), "--label", "issue-agent.run=" + runId,
    "--user", uid + ":" + gid, "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--read-only", "--pids-limit=128", "--memory", sandbox.memoryMb + "m",
    "--memory-swap", sandbox.memoryMb + "m", "--cpus", String(sandbox.cpus),
    "--network", sandbox.network, "--log-driver=none", "--no-healthcheck",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs", "/home/agent:rw,nosuid,nodev,size=64m,mode=1777",
    "--env", "HOME=/home/agent", "--env", "CI=true",
    ...sandbox.secretNames.flatMap(name => ["--env", name]),
    "--mount", "type=bind,src=" + directory + ",dst=/workspace" + (role === "opus" ? "" : ",readonly"),
    "--workdir", "/workspace", "--entrypoint", sandbox[role].executable,
    sandbox.image, ...sandbox[role].argv]
}
export class DockerWorker implements Worker {
  constructor(private config: Config, private secrets: NodeJS.ProcessEnv = process.env) {}
  private async remove(runId: string, role: Role): Promise<void> {
    const env = { ...cleanEnvironment(), DOCKER_CONFIG: join(this.config.stateDir, "docker-client") }
    const options = { cwd: this.config.stateDir, env, timeoutMs: 30_000 }
    const name = containerName(runId, role)
    const result = await runProcess(this.config.sandbox.executable,
      ["container", "ls", "--all", "--quiet", "--filter", "name=^/" + name + "$", "--filter", "label=issue-agent.run=" + runId], options)
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean)
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new PolicyError("Unexpected Docker container ID")
    if (ids.length) await runProcess(this.config.sandbox.executable, ["container", "rm", "--force", ...ids], options)
  }
  async recover(runId: string): Promise<void> {
    for (const role of ["grok", "fable", "opus"] as const) await this.remove(runId, role)
  }
  async run(role: Role, runId: string, directory: string, prompt: string, signal?: AbortSignal): Promise<string> {
    if (process.platform !== "linux") throw new PolicyError("Live workers require a Linux Docker host")
    const uid = process.getuid!(), gid = process.getgid!()
    const env = workerEnvironment(this.config, this.secrets)
    const args = dockerArguments(this.config, role, runId, directory, uid, gid)
    try {
      const output = await runProcess(this.config.sandbox.executable, args, {
        cwd: this.config.stateDir, env, stdin: prompt, timeoutMs: this.config.workerTimeoutSeconds * 1000, signal,
      })
      let safe = output.stdout
      // Worker credentials are never written into the journal or GitHub comments.
      for (const name of this.config.sandbox.secretNames) if (env[name]) safe = safe.split(env[name]!).join("[REDACTED]")
      return safe
    } finally {
      // Killing the attached docker CLI alone does not reliably stop a container.
      await this.remove(runId, role)
    }
  }
}
