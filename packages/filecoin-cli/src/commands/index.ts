import { type CommandNode, defineGroup } from 'clipact'
import { inspect as inspectDataSet } from './datasets/inspect.ts'
import { ls as listDataSets } from './datasets/ls.ts'
import { remove } from './delete.ts'
import { doctor } from './doctor.ts'
import { get } from './get.ts'
import { inspect } from './inspect.ts'
import { login } from './login.ts'
import { logout } from './logout.ts'
import { ls } from './ls.ts'
import { inspect as inspectOperation } from './operations/inspect.ts'
import { ls as listOperations } from './operations/ls.ts'
import { resume } from './operations/resume.ts'
import { put } from './put.ts'
import { status } from './status.ts'

/** `filecoin operations`: find, inspect, and resume saved put and delete jobs. */
export const operations = defineGroup({
  name: 'operations',
  description: 'Find, inspect, and resume saved put and delete jobs',
  commands: [listOperations, inspectOperation, resume],
})

/** `filecoin datasets`: the wallet's data sets, read from filecoin-api. */
export const datasets = defineGroup({
  name: 'datasets',
  description: "Read the wallet's data sets and their pieces from filecoin-api",
  commands: [listDataSets, inspectDataSet],
})

/** The `filecoin` command tree: definitions only, no handlers or SDKs. */
export const commands: CommandNode[] = [
  login,
  logout,
  status,
  doctor,
  put,
  get,
  ls,
  inspect,
  remove,
  datasets,
  operations,
]
