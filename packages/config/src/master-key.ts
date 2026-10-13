import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

/** 64 位十六进制 = 32 字节。与 loadConfig 里的校验同一副尺子。 */
const MASTER_KEY_PATTERN = /^[0-9a-fA-F]{64}$/

/** 卷上密钥文件的默认位置。镜像把 STUDIO_SECRETS_DIR 指到挂载点，这里只是兜底。 */
export const DEFAULT_SECRETS_DIR = '/var/lib/studio/secrets'
export const MASTER_KEY_FILENAME = 'master.key'

export type MasterKeySource = 'environment' | 'volume' | 'generated' | 'development'

export interface EnsureMasterKeyOptions {
  /** 默认 process.env。命中时会就地写回 STUDIO_MASTER_KEY，好让随后的 loadConfig 读到。 */
  env?: Record<string, string | undefined>
  /** 覆盖 STUDIO_SECRETS_DIR。测试用。 */
  secretsDir?: string
  onNotice?: (message: string) => void
}

export interface MasterKeyResolution {
  source: MasterKeySource
  file?: string
}

type KeyFileState =
  | { kind: 'missing' }
  | { kind: 'key'; value: string }
  | { kind: 'invalid' }
  | { kind: 'unreadable'; error: unknown }

/**
 * 让 production 首启也能零配置起来：密钥没给就补一把，并且**落盘**。
 *
 * 为什么不每次启动现生成：这把密钥加密 DB 里的 provider 凭据
 * （`encryptSecret(apiKey, masterKey)`）。换一次钥匙 = 已存的凭据全部解不开，
 * 用户得把所有模型 key 重填一遍。所以它必须「有且稳定」。
 *
 * 为什么落在卷上：api 与 worker 必须拿到**同一把**——api 加密、worker 解密。
 * 两个容器共用同一个挂载点，写在那里是最短的路径。而两者是**并行启动**的
 * （worker 的 depends_on 里没有 api），所以并发必须收敛：先把内容写进临时文件，
 * 再用 link 落地。link 是原子的，只可能有一方成功，输的一方去读赢家写好的内容。
 * 直接在 final 上 open('wx') 再原地写会留下「文件已建、内容还没写」的窗口，
 * 输的一方可能读到空文件。
 *
 * 开发态与测试态不落盘：那种场景 loadConfig 用 DEV_MASTER_KEY 兜底，
 * 往磁盘上写文件只会平白多出一份没人管理的状态。
 */
export function ensureMasterKey(options: EnsureMasterKeyOptions = {}): MasterKeyResolution {
  const env = options.env ?? process.env
  const notice = options.onNotice ?? ((message: string) => process.stderr.write(`${message}\n`))

  const configured = (env.STUDIO_MASTER_KEY ?? '').trim()
  if (MASTER_KEY_PATTERN.test(configured)) {
    // 与 loadConfig 同一套归一化（它会把 key 转小写）：留一份大小写不一致的
    // 副本在 process.env 里，只会在排查「为什么换 key 没生效」时误导人。
    env.STUDIO_MASTER_KEY = configured.toLowerCase()
    return { source: 'environment' }
  }

  if (env.NODE_ENV !== 'production') return { source: 'development' }

  const dir = options.secretsDir ?? env.STUDIO_SECRETS_DIR ?? DEFAULT_SECRETS_DIR
  const file = path.join(dir, MASTER_KEY_FILENAME)

  const state = inspectKeyFile(file)
  if (state.kind === 'key') {
    env.STUDIO_MASTER_KEY = state.value
    return { source: 'volume', file }
  }
  if (state.kind === 'invalid') throw new Error(invalidKeyFileMessage(file))
  if (state.kind === 'unreadable') throw new Error(`cannot read the master key file: ${file} (${reason(state.error)}). ${remedy()}`)

  const generated = randomBytes(32).toString('hex')
  const staging = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(persistFailureMessage(file, error))
  }

  let lost = false
  try {
    writeKeyFile(staging, generated)
    try {
      linkSync(staging, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      lost = true
    }
  } catch (error) {
    throw new Error(persistFailureMessage(file, error))
  } finally {
    try {
      unlinkSync(staging)
    } catch {
      // 已经随 link 落地，或本来就没建起来——都不是错误。
    }
  }

  if (lost) {
    // 另一方先落地了：用它的。各生成一把等于所有已存凭据作废。
    const settled = inspectKeyFile(file)
    if (settled.kind !== 'key') throw new Error(invalidKeyFileMessage(file))
    env.STUDIO_MASTER_KEY = settled.value
    return { source: 'volume', file }
  }

  env.STUDIO_MASTER_KEY = generated
  notice(
    `[config] generated a new STUDIO_MASTER_KEY and stored it at ${file} (mode 600). ` +
      'It decrypts every stored provider credential: keep this file, and keep it alongside your database backups.',
  )
  return { source: 'generated', file }
}

function writeKeyFile(file: string, key: string): void {
  const fd = openSync(file, 'wx', 0o600)
  try {
    writeSync(fd, key)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function inspectKeyFile(file: string): KeyFileState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error }
  }
  const value = raw.trim()
  return MASTER_KEY_PATTERN.test(value) ? { kind: 'key', value: value.toLowerCase() } : { kind: 'invalid' }
}

function remedy(): string {
  return 'Set STUDIO_MASTER_KEY explicitly, or point STUDIO_SECRETS_DIR at a writable directory.'
}

function invalidKeyFileMessage(file: string): string {
  return `the master key file does not hold a 64-hex key, and overwriting it would make every stored provider credential undecryptable: ${file}. ${remedy()}`
}

function persistFailureMessage(file: string, error: unknown): string {
  return `cannot persist the master key: ${file} (${reason(error)}). ${remedy()}`
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
