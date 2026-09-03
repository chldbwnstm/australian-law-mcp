import { createRequire } from "module"
const require = createRequire(import.meta.url)
const pkg = require("../package.json")
export const VERSION: string = pkg.version
export const SERVER_NAME: string = pkg.name
