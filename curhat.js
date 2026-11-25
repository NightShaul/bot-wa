// Teman curhat AI lewat API BetaBotz (https://api.betabotz.eu.org).
// Wajib: env BETABOTZ_APIKEY. Riwayat obrolan HANYA di memori (nggak ditulis ke disk, karena isinya pribadi).
// Yang disimpan ke disk cuma daftar user yang mode curhat-nya aktif (curhat.json).
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = 'https://api.betabotz.eu.org/api/search'
// urutan dicoba: kalau yang pertama gagal/kosong, lanjut ke berikutnya
const PROVIDERS = ['openai-logic', 'openai-chat']
const BOT_NAME = 'SZ-BOT' // nama yang dipakai AI saat memperkenalkan diri (ganti sesukamu)
const MAX_TURNS = 6 // giliran terakhir yang diingat
const IDLE_MS = 6 * 3600 * 1000 // riwayat dibuang kalau 6 jam nggak dipakai
const TIMEOUT_MS = 30000

// header mirip curl supaya nggak dianggap bot oleh proteksi anti-bot server
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'curl/8.5.0',
}

const PERSONA =
  'Kamu teman curhat yang hangat dan mau mendengarkan. Balas dalam bahasa Indonesia yang santai, ' +
  'singkat (2-4 kalimat), tanpa menggurui dan jangan langsung kasih solusi. Validasi perasaannya dulu, ' +
  'lalu tanya pelan-pelan kalau perlu. Kamu bukan psikolog; kalau masalahnya berat, sarankan dengan lembut ' +
  'untuk cerita ke orang terdekat atau profesional.'

// identitas + persona. Kalau ditanya siapa kamu: jawab sebagai BOT_NAME, jangan sebut BetaBotz/Lann.
const SYSTEM =
  `Namamu ${BOT_NAME}, asisten AI di bot WhatsApp. Kamu AI, bukan manusia. ` +
  'Kalau ditanya siapa kamu atau siapa pembuatmu, jawab bahwa kamu ' + BOT_NAME + ' dan jangan menyebut BetaBotz atau Lann. ' +
  PERSONA

const CRISIS =
  /(bunuh diri|mau mati|ingin mati|pengen mati|pengin mati|akhiri hidup|mengakhiri hidup|menyakiti diri|nyakitin diri|melukai diri|ngelukain diri|self.?harm|suicide|nggak mau hidup|gak mau hidup|capek hidup)/i
export const isCrisis = (t) => CRISIS.test(String(t || ''))
export const CRISIS_REPLY =
  'Aku dengar kamu lagi berat banget, dan aku peduli sama kamu. Tolong jangan sendirian dulu: ' +
  'ceritakan ke orang terdekat yang kamu percaya, atau hubungi psikolog/layanan krisis di tempatmu. ' +
  'Kalau kamu merasa dalam bahaya sekarang, segera hubungi layanan darurat setempat. ' +
  'Aku di sini kalau kamu mau cerita.'

// ---------- mode aktif (disimpan) ----------
const FILE = 'curhat.json'
let on = new Set()
try {
  on = new Set(JSON.parse(readFileSync(FILE, 'utf8')))
} catch {}
const saveOn = () => {
  try {
    writeFileSync(FILE, JSON.stringify([...on]))
  } catch (e) {
    console.error('gagal simpan curhat.json:', e.message)
  }
}
export const isCurhatOn = (id) => on.has(id)
export function setCurhatOn(id, v) {
  v ? on.add(id) : on.delete(id)
  saveOn()
}

// ---------- riwayat (memori saja) ----------
const sessions = new Map() // id -> { hist: [{role,text}], ts }
export const resetCurhat = (id) => sessions.delete(id)
function prune() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.ts > IDLE_MS) sessions.delete(k)
}

// ---------- panggil API ----------
function pickAnswer(raw, label) {
  let d
  try {
    d = JSON.parse(raw)
  } catch {
    throw new Error(`${label}: balasan bukan JSON`)
  }
  const a = [d.message, d.result, d.response, d.text].find((x) => typeof x === 'string' && x.trim())
  if (!a) throw new Error(`${label}: jawaban kosong`)
  if (/<html|service suspended/i.test(a)) throw new Error(`${label}: layanan lagi suspend`)
  return a.trim()
}

async function request(label, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const raw = await res.text()
  if (!res.ok) {
    // isi balasan ditampilkan di log supaya penyebab 403 kelihatan (anti-bot / apikey / limit)
    console.error(`curhat ${label} HTTP ${res.status}:`, raw.slice(0, 300).replace(/\s+/g, ' '))
    const e = new Error(`${label}: HTTP ${res.status}`)
    e.status = res.status
    throw e
  }
  return pickAnswer(raw, label)
}

// params = { text, logic? }. logic = instruksi sistem (cuma dipakai endpoint openai-logic)
async function ask(provider, params) {
  const key = process.env.BETABOTZ_APIKEY
  if (!key) throw new Error('BETABOTZ_APIKEY belum di-set.')
  const data = { apikey: key, ...params }

  try {
    return await request(`${provider} POST`, `${BASE}/${provider}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(data),
    })
  } catch (e) {
    // kalau ditolak (403/401/405/429), coba sekali lagi pakai GET
    if (![401, 403, 405, 429].includes(e.status)) throw e
  }
  const qs = new URLSearchParams(data)
  return request(`${provider} GET`, `${BASE}/${provider}?${qs}`, { headers: HEADERS })
}

// ganti identitas bawaan API di hasil jawaban
const fixIdentity = (a) =>
  a
    .replace(/BetaBotz[-\s]?Ai/gi, BOT_NAME)
    .replace(/(diciptakan|dibuat|dikembangkan|dibangun)\s+oleh\s+Lann/gi, `dibuat oleh pemilik ${BOT_NAME}`)
    .replace(/\bLann\b/g, 'pemilikku')

export async function curhat(id, userText) {
  prune()
  const s = sessions.get(id) || { hist: [], ts: 0 }
  const convo = s.hist.map((h) => `${h.role === 'user' ? 'Aku' : 'Kamu'}: ${h.text}`).join('\n')
  const body = (c) => `${c ? c + '\n' : ''}Aku: ${userText}\nKamu:`
  let chat = body(convo)
  // GET membawa teks di URL, jadi jaga supaya nggak kepanjangan
  if (chat.length > 5000) chat = body('')

  let answer = ''
  let lastErr
  for (const p of PROVIDERS) {
    try {
      // openai-logic: persona di parameter logic. provider lain: persona ditempel di teks.
      answer = await ask(p, p === 'openai-logic' ? { text: chat, logic: SYSTEM } : { text: `${SYSTEM}\n\n${chat}` })
      break
    } catch (e) {
      lastErr = e
      console.error('curhat provider gagal:', e.message)
      if (/belum di-set/.test(e.message)) throw e
    }
  }
  if (!answer) throw new Error('AI lagi ramai/error, coba lagi sebentar.' + (lastErr ? ` (${lastErr.message})` : ''))

  answer = fixIdentity(answer.replace(/^\s*Kamu\s*:\s*/i, '')).slice(0, 3500)
  s.hist.push({ role: 'user', text: userText.slice(0, 1500) }, { role: 'ai', text: answer.slice(0, 1500) })
  s.hist = s.hist.slice(-MAX_TURNS * 2)
  s.ts = Date.now()
  sessions.set(id, s)
  return answer
}