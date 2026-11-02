export const ENGINES = ['postgres', 'mariadb', 'mongo'] as const
export type EngineName = (typeof ENGINES)[number]

// none = tulis normal; read_only = quota penuh; blocked = koneksi tenant ditolak total
export type WriteMode = 'none' | 'read_only' | 'blocked'

export type TenantSpec = {
  database: string
  user: string
  password: string
  maxConnections: number
  timeoutS: number
}

export interface EngineDriver {
  readonly engine: EngineName
  ping(): Promise<void>
  // Idempoten: aman diulang setelah gagal di tengah jalan (OT-1)
  provision(t: TenantSpec): Promise<void>
  deprovision(database: string, user: string): Promise<void>
  rotatePassword(user: string, password: string): Promise<void>
  sizeBytes(database: string): Promise<number>
  setWriteMode(database: string, user: string, mode: WriteMode): Promise<void>
  // Dipakai test isolasi (NFR-01) dan verifikasi provisioning
  tenantCanConnect(database: string, user: string, password: string): Promise<boolean>
  connectionString(host: string, port: number, database: string, user: string, password: string): string
  close(): Promise<void>
}

// Identifier di-interpolasi ke SQL, jadi hanya terima nama yang dibentuk platform sendiri
const IDENT = /^[a-z][a-z0-9_]{0,62}$/
export function ident(name: string) {
  if (!IDENT.test(name)) throw new Error(`identifier tidak valid: ${name}`)
  return name
}
