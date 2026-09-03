import { existsSync, lstatSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const buildDir = resolve(root, "build")

// Never make a recursive cleanup depend on an environment variable or a path
// outside this package root.  Build is the only generated publish directory.
if (dirname(buildDir) !== root) {
  throw new Error("Refusing to clean an unexpected build directory.")
}
if (existsSync(buildDir)) {
  if (!lstatSync(buildDir).isDirectory()) {
    throw new Error("Refusing to remove build because it is not a directory.")
  }
  rmSync(buildDir, { recursive: true, force: false })
}
