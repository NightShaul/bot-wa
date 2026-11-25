// Loader .env sederhana (tanpa library, jalan di Node versi berapa pun).
// Baca file .env di folder tempat bot dijalankan. Variabel yang sudah di-set di terminal tidak ditimpa.
import { readFileSync } from 'node:fs'

try {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
} catch {
  // nggak ada .env: nggak apa-apa
}