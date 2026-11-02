// AES-256-GCM untuk password database di metadata (NFR-03). Format: v1.<iv>.<tag>.<ciphertext> (base64url)
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

export function makeCipher(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY harus 32 byte (base64)')
  return {
    encrypt(plain: string) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return ['v1', iv, c.getAuthTag(), ct].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
    },
    decrypt(enc: string) {
      const [v, iv, tag, ct] = enc.split('.')
      if (v !== 'v1') throw new Error('format ciphertext tidak dikenal')
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      d.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
    },
  }
}
export type Cipher = ReturnType<typeof makeCipher>

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

// Password tanpa karakter yang perlu di-escape di URL, shell, maupun SQL
export function generatePassword(length = 32) {
  const out: string[] = []
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 256 - (256 % ALPHABET.length)) out.push(ALPHABET[b % ALPHABET.length])
      if (out.length === length) break
    }
  }
  return out.join('')
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
