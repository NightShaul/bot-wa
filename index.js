import './env.js'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
  prepareWAMessageMedia,
  generateMessageID,
  proto,
  Browsers,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { rpgCommand, userIdOf, addCredit, takeLimit, refundLimit, limitInfo, creditOf, noLimitText } from './rpg.js'
import { box } from './ui.js'
import { curhat, resetCurhat, isCrisis, CRISIS_REPLY, isCurhatOn, setCurhatOn } from './curhat.js'
import { fetchInfo, downloadAudio, downloadVideo, isUrl, MAX_AUDIO_SEC, MAX_VIDEO_SEC } from './dl.js'

// ================= PENGATURAN =================
const PREFIX = '.'
const MAX_SECONDS = 10 // durasi maksimal video jadi stiker
const SOUND_MAX_SECONDS = 10 // batas audio di sound sticker (lebih dari ini sering gagal diputar)
const MAX_STICKER_BYTES = 1000 * 1000 // batas WA ~1MB untuk stiker animasi
const STICKER_PACK = 'SZ-BOT V1' // nama paket stiker yang tampil di WhatsApp
const STICKER_AUTHOR = 'SZ-BOT V1' // nama pembuat/publisher paket
// Nomor owner tambahan (selain akun yang dipakai bot itu sendiri), format 628xxx.
// Bisa juga lewat env: OWNER_NUMBERS=628111,628222
const OWNER_NUMBERS = ['']

// Info yang tampil di perintah .owner
const OWNER_NAME = 'Owner SZ-BOT'
// Nomor yang ditampilkan (format 628xxx). Kosongkan kalau mau otomatis pakai nomor owner
// pertama di atas, atau nomor akun bot ini.
const OWNER_CONTACT = '6285942173650'
// ==============================================

const logger = pino({ level: 'silent' })

// ---------- mode public / private ----------
const SETTINGS_FILE = 'settings.json'
function loadMode() {
  try {
    const m = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).mode
    return m === 'public' ? 'public' : 'private'
  } catch {
    return 'private' // default: cuma owner
  }
}
let mode = loadMode()
const saveMode = () => writeFileSync(SETTINGS_FILE, JSON.stringify({ mode }))

const ownerDigits = [...OWNER_NUMBERS, ...(process.env.OWNER_NUMBERS || '').split(',')]
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean)

function isOwnerMsg(m) {
  if (m.key.fromMe) return true // pesan dari akun bot sendiri
  const ids = [m.key.participant, m.key.participantAlt, m.key.remoteJid, m.key.remoteJidAlt]
  return ids.some((j) => j && ownerDigits.includes(j.split('@')[0].split(':')[0]))
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()) }))
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let err = ''
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => reject(new Error(`Gagal jalanin ${cmd}: ${e.message} (ffmpeg sudah terinstall?)`)))
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-500)))))
  })
}

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wabot-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- nama paket stiker (EXIF di dalam file webp) ----------
function addStickerExif(webp) {
  if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') return webp
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': 'sz-bot-v1',
    'sticker-pack-name': STICKER_PACK,
    'sticker-pack-publisher': STICKER_AUTHOR,
    emojis: [''],
  }), 'utf8')
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
  const exif = Buffer.concat([head, json])
  exif.writeUInt32LE(json.length, 14)

  let body = Buffer.from(webp.subarray(12))
  const fourcc = body.toString('ascii', 0, 4)
  if (fourcc === 'VP8X') {
    body[8] |= 0x08 // nyalakan flag EXIF
  } else {
    // webp sederhana: bungkus pakai chunk VP8X (kanvas 512x512 sesuai hasil ffmpeg)
    const vp8x = Buffer.alloc(18)
    vp8x.write('VP8X', 0, 'ascii')
    vp8x.writeUInt32LE(10, 4)
    vp8x[8] = 0x08
    vp8x.writeUIntLE(511, 12, 3)
    vp8x.writeUIntLE(511, 15, 3)
    body = Buffer.concat([vp8x, body])
  }
  const chunk = Buffer.alloc(8)
  chunk.write('EXIF', 0, 'ascii')
  chunk.writeUInt32LE(exif.length, 4)
  const pad = exif.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
  const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), body, chunk, exif, pad])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(payload.length, 4)
  return Buffer.concat([riff, payload])
}

// ---------- konversi ----------
async function toSticker(buffer, kind) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.bin')
    const out = path.join(dir, 'out.webp')
    await writeFile(inp, buffer)

    // Percobaan berurutan dari kualitas bagus ke makin hemat: [fps, kualitas, durasi maks].
    // Kalau masih kebesaran, fps diturunkan, lalu terakhir durasi dipotong.
    const attempts =
      kind === 'video'
        ? [
            [12, 50, MAX_SECONDS], [12, 30, MAX_SECONDS], [10, 20, MAX_SECONDS],
            [8, 15, MAX_SECONDS], [8, 8, MAX_SECONDS],
            [8, 8, Math.min(MAX_SECONDS, 15)], [6, 5, Math.min(MAX_SECONDS, 10)],
          ]
        : [[0, 50, 0], [0, 35, 0], [0, 25, 0], [0, 15, 0], [0, 8, 0]]

    for (const [fps, q, sec] of attempts) {
      const vf =
        (kind === 'video' ? `fps=${fps},` : '') +
        'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
        'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
      const args = ['-y', '-i', inp]
      if (kind === 'video') args.push('-t', String(sec))
      args.push('-vf', vf, '-an', '-vcodec', 'libwebp', '-lossless', '0',
        '-q:v', String(q), '-compression_level', '3', '-loop', '0', out)
      await run('ffmpeg', args)
      const result = await readFile(out)
      if (result.length <= MAX_STICKER_BYTES) return addStickerExif(result)
    }
    throw new Error('Hasil stiker masih kebesaran walau sudah dihemat. Coba video yang lebih pendek/sederhana.')
  })
}

async function toAudio(buffer, maxSec) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.bin')
    const out = path.join(dir, 'out.mp3')
    await writeFile(inp, buffer)
    const args = ['-y', '-i', inp, '-vn']
    if (maxSec) args.push('-t', String(maxSec))
    args.push('-c:a', 'libmp3lame', '-b:a', '128k', out)
    try {
      await run('ffmpeg', args)
    } catch (e) {
      if (/does not contain any stream|Output file #0/i.test(e.message)) {
        throw new Error('Videonya nggak ada suaranya.')
      }
      throw e
    }
    return readFile(out)
  })
}

// ---------- SOUND STICKER (stiker + suara, satu pesan) ----------
// WhatsApp mengirimnya sebagai Message.audioStickerMessage (field 134) -> FutureProofMessage
// -> stickerMessage yang punya audioMessage (field 26). Baileys belum punya field 134 di
// proto-nya, jadi kita tulis bytes-nya manual lalu tempel ke hasil encode.
const RAW_AUDIO_STICKER = Symbol('rawAudioSticker')
const origEncode = proto.Message.encode
proto.Message.encode = function (m, w) {
  const writer = origEncode.call(this, m, w)
  if (m && m[RAW_AUDIO_STICKER]) writer.uint32((134 << 3) | 2).bytes(m[RAW_AUDIO_STICKER])
  return writer
}

const varint = (n) => {
  const b = []
  while (n > 127) { b.push((n & 127) | 128); n >>>= 7 }
  b.push(n)
  return Buffer.from(b)
}
const lenField = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf])

async function toOpus(buffer, maxSec) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.bin')
    const out = path.join(dir, 'out.ogg')
    await writeFile(inp, buffer)
    try {
      await run('ffmpeg', ['-y', '-i', inp, '-vn', '-t', String(maxSec), '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', out])
    } catch (e) {
      if (/does not contain any stream|Output file #0/i.test(e.message)) {
        throw new Error('Videonya nggak ada suaranya.')
      }
      throw e
    }
    const dur = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])
    return { buf: await readFile(out), seconds: Math.max(1, Math.round(parseFloat(dur) || maxSec)) }
  })
}

async function sendSoundSticker(sock, jid, videoBuf) {
  // encode stiker & audio bersamaan, lalu upload keduanya bersamaan
  const [webp, { buf: ogg, seconds }] = await Promise.all([
    toSticker(videoBuf, 'video'),
    toOpus(videoBuf, SOUND_MAX_SECONDS),
  ])
  const up = { upload: sock.waUploadToServer }

  const [{ stickerMessage }, { audioMessage }] = await Promise.all([
    prepareWAMessageMedia({ sticker: webp }, up),
    prepareWAMessageMedia({ audio: ogg, mimetype: 'audio/ogg; codecs=opus', seconds }, up),
  ])

  const sBytes = proto.Message.StickerMessage.encode(
    proto.Message.StickerMessage.fromObject({ ...stickerMessage, isAnimated: true, width: 512, height: 512 })).finish()
  const aBytes = proto.Message.AudioMessage.encode(
    proto.Message.AudioMessage.fromObject({ ...audioMessage, ptt: false, seconds })).finish()

  const stickerWithAudio = Buffer.concat([sBytes, lenField(26, aBytes)]) // StickerMessage.audioMessage = 26
  const future = lenField(1, lenField(26, stickerWithAudio)) // FutureProofMessage.message{ stickerMessage=26 }

  await sock.relayMessage(jid, { [RAW_AUDIO_STICKER]: future }, { messageId: generateMessageID() })
}

// ---------- gambar anime (SFW) ----------
// Sumber utama: nekos.best (tanpa apikey, wajib User-Agent). Cadangan: waifu.pics.
const ANIME_CMDS = { anime: null, waifu: 'waifu', neko: 'neko', husbando: 'husbando', kitsune: 'kitsune' }
const UA = { 'User-Agent': 'WaStickerBot/1.0' }

async function getAnimeImage(category) {
  const pool = ['waifu', 'neko', 'husbando', 'kitsune']
  const cat = category || pool[Math.floor(Math.random() * pool.length)]
  try {
    const r = await fetch(`https://nekos.best/api/v2/${cat}`, { headers: UA, signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const x = (await r.json()).results?.[0]
    if (x?.url) {
      const caption = [x.anime_name && `anime: ${x.anime_name}`, x.artist_name && `art: ${x.artist_name}`, x.source_url]
        .filter(Boolean).join('\n')
      return { url: x.url, caption }
    }
  } catch (e) {
    console.error('nekos.best gagal:', e.message)
  }
  // cadangan
  const wcat = ['waifu', 'neko'].includes(cat) ? cat : 'waifu'
  const r2 = await fetch(`https://api.waifu.pics/sfw/${wcat}`, { headers: UA, signal: AbortSignal.timeout(10000) })
  if (!r2.ok) throw new Error('Sumber gambar sedang bermasalah, coba lagi nanti.')
  const j = await r2.json()
  if (!j.url) throw new Error('Sumber gambar nggak ngasih gambar, coba lagi.')
  return { url: j.url, caption: '' }
}

async function downloadBuffer(url, maxBytes = 64 * 1024 * 1024) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`Gagal download (HTTP ${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > maxBytes) throw new Error('File terlalu besar.')
  return buf
}

// ---------- GIF reaksi (.kiss, .hug, dll) ----------
// verb = kata kerja untuk caption "@kamu mencium @dia"
const REACTIONS = {
  kiss: 'mencium', hug: 'memeluk', pat: 'mengelus kepala', slap: 'menampar',
  cuddle: 'memeluk erat', tickle: 'menggelitik', wave: 'melambai ke', wink: 'mengedip ke',
  baka: 'bilang baka ke', laugh: 'menertawakan', yawn: 'menguap di depan',
}
const WAIFU_PICS_GIFS = ['kiss', 'hug', 'pat', 'slap', 'cuddle', 'wave', 'wink'] // cadangan

async function gifToMp4(buffer) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.gif')
    const out = path.join(dir, 'out.mp4')
    await writeFile(inp, buffer)
    await run('ffmpeg', ['-y', '-i', inp, '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', out])
    return readFile(out)
  })
}

async function getReactionGif(cat) {
  try {
    const r = await fetch(`https://nekos.best/api/v2/${cat}`, { headers: UA, signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const x = (await r.json()).results?.[0]
    if (x?.url) return { gif: await downloadBuffer(x.url), anime: x.anime_name || '' }
  } catch (e) {
    console.error('nekos.best (gif) gagal:', e.message)
  }
  if (!WAIFU_PICS_GIFS.includes(cat)) throw new Error('Sumber GIF sedang bermasalah, coba lagi nanti.')
  const r2 = await fetch(`https://api.waifu.pics/sfw/${cat}`, { headers: UA, signal: AbortSignal.timeout(10000) })
  const j = await r2.json()
  if (!r2.ok || !j.url) throw new Error('Sumber GIF sedang bermasalah, coba lagi nanti.')
  return { gif: await downloadBuffer(j.url), anime: '' }
}

// ---------- TikTok tanpa watermark (lewat TikWM) ----------
async function tiktokDl(url) {
  const r = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url, hd: '1' }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j || j.code !== 0 || !j.data) throw new Error(j?.msg || 'Video nggak ketemu / link salah.')
  const d = j.data
  const abs = (u) => (u ? (u.startsWith('http') ? u : `https://www.tikwm.com${u}`) : null)
  return {
    video: abs(d.hdplay || d.play),
    images: Array.isArray(d.images) ? d.images : [],
    title: d.title || '',
    author: d.author?.unique_id || d.author?.nickname || '',
  }
}

// ---------- .hd (perjelas gambar, lokal pakai ffmpeg) ----------
// Ini bukan AI upscaler: gambar diperbesar 2x (maks sisi panjang 1280 dulu), dikurangi noise, lalu dipertajam.
async function enhanceImage(buffer) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.bin')
    const out = path.join(dir, 'out.jpg')
    await writeFile(inp, buffer)
    await run('ffmpeg', ['-y', '-i', inp, '-vf',
      "scale=w='if(gt(max(iw\\,ih)\\,1280)\\,iw\\,iw*2)':h=-2:flags=lanczos,hqdn3d=1.2:1.2:4:4,unsharp=5:5:0.9:5:5:0.0",
      '-q:v', '2', out])
    return readFile(out)
  })
}

// ---------- .brat (stiker teks gaya brat) ----------
const FONT_CANDIDATES = [
  process.env.BRAT_FONT,
  '/system/fonts/Roboto-Regular.ttf',
  '/system/fonts/NotoSans-Regular.ttf',
  '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
].filter(Boolean)

function wrapText(text, perLine) {
  const lines = []
  let cur = ''
  for (let word of text.split(' ')) {
    while (word.length > perLine) { // kata kepanjangan dipotong
      if (cur) { lines.push(cur); cur = '' }
      lines.push(word.slice(0, perLine))
      word = word.slice(perLine)
    }
    if (!cur) cur = word
    else if ((cur + ' ' + word).length <= perLine) cur += ' ' + word
    else { lines.push(cur); cur = word }
  }
  if (cur) lines.push(cur)
  return lines
}

async function bratImage(text) {
  const font = FONT_CANDIDATES.find((f) => existsSync(f))
  if (!font) throw new Error('font nggak ketemu. Isi path font lewat env: BRAT_FONT=/path/ke/font.ttf')
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  const n = t.length
  const size = n <= 8 ? 150 : n <= 16 ? 110 : n <= 30 ? 80 : n <= 60 ? 58 : n <= 110 ? 44 : 34
  const perLine = Math.max(4, Math.floor((512 - 64) / (size * 0.6)))
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return withTmp(async (dir) => {
    const txt = path.join(dir, 't.txt')
    const out = path.join(dir, 'out.png')
    await writeFile(txt, wrapText(t, perLine).join('\n'))
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=512x512', '-frames:v', '1', '-vf',
      `drawtext=fontfile='${esc(font)}':textfile='${esc(txt)}':expansion=none:fontsize=${size}:` +
      `fontcolor=black:x=32:y=32:line_spacing=${-Math.round(size * 0.12)},gblur=sigma=1.6`, out])
    return readFile(out)
  })
}

// ---------- game tebak-tebakan ----------
// Soal diambil dari file JSON komunitas (gratis, tanpa apikey). Kalau satu sumber mati, coba sumber berikutnya.
const GAME_SOURCES = {
  gambar: [
    'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar.json',
    'https://huggingface.co/RamaZyx/StableBOT/resolve/main/json/tebakgambar.json',
  ],
  lagu: [
    'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebaklagu.json',
    'https://huggingface.co/RamaZyx/StableBOT/resolve/main/json/tebaklagu.json',
  ],
  kata: [
    'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakkata.json',
    'https://huggingface.co/RamaZyx/StableBOT/resolve/main/json/tebakkata.json',
  ],
  ff: [
    'https://raw.githubusercontent.com/siputzx/Databasee/main/games/tebakff.json',
    'https://huggingface.co/RamaZyx/StableBOT/resolve/main/json/tebakff.json',
  ],
  ml: [
    'https://raw.githubusercontent.com/siputzx/Databasee/main/games/tebakml.json',
    'https://huggingface.co/RamaZyx/StableBOT/resolve/main/json/tebakml.json',
  ],
  negara: [
    'https://raw.githubusercontent.com/siputzx/Databasee/main/games/tebaknegara.json',
    'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakbendera.json',
  ],
}
// Mau pakai sumber sendiri? GAME_URL_FF=https://.../tebakff.json npm start (sama utk _ML, _NEGARA, _KATA, dst)
for (const k of Object.keys(GAME_SOURCES)) {
  const u = process.env[`GAME_URL_${k.toUpperCase()}`]
  if (u) GAME_SOURCES[k].unshift(u)
}
const GAME_TITLE = {
  gambar: 'tebak gambar',
  lagu: 'tebak judul lagunya',
  kata: 'tebak kata',
  ff: 'tebak karakter/item free fire',
  ml: 'tebak hero mobile legends',
  negara: 'tebak negara',
}
const GAME_CMD = {
  tebakgambar: 'gambar',
  tebaklagu: 'lagu',
  tebakaudio: 'lagu',
  tebakkata: 'kata',
  tebakff: 'ff',
  tebakml: 'ml',
  tebaknegara: 'negara',
}
const GAME_SECONDS = 60
const games = new Map() // jid -> { answer, timer }
const gameCache = {}
const normAnswer = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')

function normalizeGameItem(x) {
  if (!x || typeof x !== 'object') return null
  const answer = x.jawaban ?? x.answer ?? x.name ?? x.nama
  if (!answer || typeof answer !== 'string' && typeof answer !== 'number') return null
  const question = x.soal ?? x.question ?? x.pertanyaan
  const media = [x.img, x.image, x.gambar, x.link_song, x.audio, x.url]
    .find((v) => typeof v === 'string' && /^https?:\/\//.test(v))
  if (!media && !question) return null // harus ada soal teks atau media
  return { answer: String(answer), question: question ? String(question) : '', media }
}

async function loadGame(kind) {
  if (gameCache[kind]?.length) return gameCache[kind]
  for (const url of GAME_SOURCES[kind]) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      let j = await r.json()
      if (!Array.isArray(j)) j = j.data || j.result || Object.values(j)
      const list = j.map(normalizeGameItem).filter(Boolean)
      if (list.length) return (gameCache[kind] = list)
      throw new Error('isi file nggak sesuai format')
    } catch (e) {
      console.error(`sumber soal ${kind} gagal (${url}): ${e.message}`)
    }
  }
  throw new Error('sumber soal lagi bermasalah, coba lagi nanti.')
}

async function startGame(sock, m, kind) {
  const jid = m.key.remoteJid
  const say = (text) => sock.sendMessage(jid, { text }, { quoted: m })
  if (games.has(jid)) return say(`masih ada soal yang belum kejawab. jawab aja, atau ketik ${cmdTxt('nyerah')}`)
  const g = { answer: '', timer: null }
  games.set(jid, g) // kunci dulu supaya nggak dobel
  try {
    const list = await loadGame(kind)
    const item = list[Math.floor(Math.random() * list.length)]
    g.answer = item.answer
    const pattern = item.answer.split('').map((c) => (c === ' ' ? ' ' : '_')).join(' ')
    const info = `${pattern}\nwaktu ${GAME_SECONDS} detik. ketik ${cmdTxt('nyerah')} kalau nyerah.`
    const head = `${GAME_TITLE[kind]}${item.question ? `\n\n${item.question}` : ''}\n\n${info}`
    if (item.media) {
      const buf = await downloadBuffer(item.media, 20 * 1024 * 1024)
      if (/\.(mp3|m4a|ogg|opus|wav)(\?|$)/i.test(item.media)) {
        await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg' }, { quoted: m })
        await say(head)
      } else {
        await sock.sendMessage(jid, { image: buf, caption: head }, { quoted: m })
      }
    } else {
      await say(head)
    }
    g.timer = setTimeout(() => {
      if (games.get(jid) !== g) return
      games.delete(jid)
      sock.sendMessage(jid, { text: `waktu habis. jawabannya: ${g.answer}` }).catch(() => {})
    }, GAME_SECONDS * 1000)
  } catch (e) {
    games.delete(jid)
    throw e
  }
}

// teks yang baru dikirim bot sendiri (supaya pesan bot nggak dianggap jawaban salah kalau ikut masuk sebagai fromMe)
const botTexts = new Set()
const rememberBotText = (t) => {
  if (!t) return
  botTexts.add(t)
  setTimeout(() => botTexts.delete(t), 120000)
}

async function checkGameAnswer(sock, m, text) {
  const jid = m.key.remoteJid
  const g = games.get(jid)
  if (!g || !g.answer || !text) return
  if (mode === 'private' && !isOwnerMsg(m)) return
  if (m.key.fromMe && botTexts.has(text)) return
  if (normAnswer(text) !== normAnswer(g.answer)) {
    if (normAnswer(text)) await sock.sendMessage(jid, { text: 'salah, coba lagi.' }, { quoted: m })
    return
  }
  clearTimeout(g.timer)
  games.delete(jid)
  const total = addCredit(userIdOf(m), m.pushName, 1)
  await sock.sendMessage(jid, { text: `bener! jawabannya ${g.answer}\n+1 credit (total: ${total})` }, { quoted: m })
}

// teks setelah perintah, atau teks dari pesan yang di-reply
function argText(text, ctx) {
  const a = text.replace(/^\S+\s*/, '').trim()
  if (a) return a
  const q = normalizeMessageContent(ctx?.quotedMessage)
  return (q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption || '').trim()
}

// ---------- ambil media dari pesan / reply ----------
function findMedia(m) {
  const content = normalizeMessageContent(m.message)
  if (!content) return null
  if (content.imageMessage) return { target: m, kind: 'image' }
  if (content.videoMessage) return { target: m, kind: 'video' }

  const ctx = content.extendedTextMessage?.contextInfo
  if (ctx?.quotedMessage) {
    const q = normalizeMessageContent(ctx.quotedMessage)
    const kind = q?.imageMessage ? 'image' : q?.videoMessage ? 'video' : null
    if (!kind) return null
    return {
      kind,
      target: {
        key: {
          remoteJid: m.key.remoteJid,
          id: ctx.stanzaId,
          participant: ctx.participant,
          fromMe: false,
        },
        message: ctx.quotedMessage,
      },
    }
  }
  return null
}

function getText(m) {
  const c = normalizeMessageContent(m.message)
  if (!c) return ''
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    ''
  )
}

const BOT_NAME = 'SZ-BOT V1'
const cmdTxt = (x) => `${PREFIX}${x}`
const fail = (msg) => box('GAGAL', [String(msg).slice(0, 300)])

// downloader: maksimal 2 unduhan berjalan bersamaan supaya bot nggak berat
const DL_MAX_PARALLEL = 2
let dlBusy = 0
const fmtDur = (sec) => {
  const s = Math.round(sec || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// ---------- MENU (teks bergaya tombol) ----------
// kategori: [judul, deskripsi singkat, [[perintah, keterangan], ...]]
const MENU = {
  stiker: ['STIKER', 'stiker, brat, mp3', [
    ['s', 'gambar/video jadi stiker'],
    ['sa', 'video jadi stiker bersuara'],
    ['sa2', 'stiker + audio terpisah'],
    ['mp3', 'audio dari video'],
    ['brat <teks>', 'stiker teks gaya brat'],
  ]],
  musik: ['MUSIK & DOWNLOADER', 'play, ytmp3, ytmp4, tiktok', [
    ['play <judul/link>', 'cari & kirim lagu (YouTube, SoundCloud, dll)'],
    ['ytmp3 <judul/link>', 'jadi audio mp3'],
    ['ytmp4 <judul/link> [360]', 'jadi video mp4 (kualitas opsional)'],
    ['tt <link>', 'tiktok tanpa watermark'],
  ]],
  anime: ['ANIME', 'gambar anime sfw', [
    ['anime', 'gambar acak'],
    ['waifu', ''], ['neko', ''], ['husbando', ''], ['kitsune', ''],
  ]],
  reaksi: ['REAKSI', 'kiss, hug, pat, dll', [
    ['kiss', ''], ['hug', ''], ['pat', ''], ['slap', ''], ['cuddle', ''],
    ['wave', ''], ['wink', ''], ['baka', ''], ['laugh', ''], ['tickle', ''], ['yawn', ''],
    ['', '(reply/tag orangnya)'],
  ]],
  game: ['GAME', 'tebak-tebakan', [
    ['tebakgambar', ''], ['tebaklagu', ''], ['tebakkata', ''],
    ['tebakff', ''], ['tebakml', ''], ['tebaknegara', ''], ['nyerah', 'menyerah'],
    ['', 'jawaban benar +1 credit'],
  ]],
  rpg: ['EKONOMI & RPG', 'credit, nambang, pet, battle', [
    ['balance', 'profil & saldo'], ['daily', 'credit harian'], ['top', 'leaderboard'],
    ['nambang', 'nambang'], ['jual', 'jual hasil tambang'],
    ['adopt', 'adopsi pet'], ['pet', 'info pet'], ['feed', 'kasih makan pet'], ['rename <nama>', 'ganti nama pet'],
    ['battle', 'pet lawan monster'],
  ]],
  toko: ['TOKO & LIMIT', 'shop, limit, premium', [
    ['shop', 'daftar item toko'],
    ['upgrade', 'upgrade beliung'],
    ['limit', 'cek limit'],
    ['buylimit <jumlah>', 'beli limit (100 limit = 50 credit)'],
  ]],
  alat: ['ALAT', 'curhat, hd, hidetag', [
    ['curhat [cerita]', 'teman curhat AI (curhat off / reset)'],
    ['hd', 'perjelas gambar (reply/kirim gambar)'],
    ['hidetag <teks>', 'tag semua member (admin)'],
  ]],
  lainnya: ['LAINNYA', 'owner, mode', [
    ['owner', 'kontak pemilik bot'],
    ['public / private', 'ganti mode (owner)'],
    ['addprem <nomor> [hari]', 'beri premium (owner)'],
    ['delprem <nomor>', 'cabut premium (owner)'],
    ['givecredit <nomor> <jml>', 'beri credit (owner)'],
  ]],
}

function menuText(section, who) {
  const c = cmdTxt
  const keys = Object.keys(MENU)
  const sec = (section || '').toLowerCase()
  const head = box(BOT_NAME, [
    `halo, ${who.name || 'kamu'}`,
    `mode: ${mode}`,
    `limit: ${who.limit}`,
    `credit: ${who.credit}`,
  ])
  const render = (k) =>
    box(MENU[k][0], MENU[k][2].map(([cmd, d]) => (cmd ? `◦ ${c(cmd)}${d ? ` - ${d}` : ''}` : `  ${d}`)))

  if (sec && sec !== 'all' && !MENU[sec]) {
    return [head, '', box('MENU', [`kategori "${sec}" nggak ada.`, `pilih: ${keys.join(', ')}`])].join('\n')
  }
  if (sec === 'all') return [head, '', ...keys.map((k) => render(k) + '\n'), `ketik ${c('menu')} untuk daftar kategori.`].join('\n')
  if (sec) return [head, '', render(sec), '', `kembali: ${c('menu')}`].join('\n')

  // menu utama: daftar kategori sebagai "tombol" teks
  const pad = Math.max(...keys.map((k) => k.length))
  const buttons = box('KATEGORI', keys.map((k) => `▸ ${c('menu ' + k.padEnd(pad))} - ${MENU[k][1]}`))
  return [
    head, '', buttons, '',
    `lihat semua: ${c('menu all')}`,
    `kirim gambar/video + caption perintah, atau reply medianya.`,
    `stiker video maks ${MAX_SECONDS} detik. kalau sound sticker nggak muncul, pakai ${c('sa2')}.`,
  ].join('\n')
}

// ---------- curhat (AI teman curhat, BetaBotz) ----------
const CURHAT_USES_LIMIT = true // ubah ke false kalau curhat mau gratis tanpa limit
const isPrivateChat = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid || '')
const noLimitAt = new Map() // uid -> waktu terakhir kirim pesan "limit habis" (biar nggak spam)

async function curhatTurn(sock, m, text) {
  const jid = m.key.remoteJid
  const uid = userIdOf(m)
  const owner = isOwnerMsg(m)
  const say = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

  if (isCrisis(text)) return say(CRISIS_REPLY) // pesan krisis nggak makan limit & nggak dikirim ke AI

  let from = null
  if (CURHAT_USES_LIMIT) {
    const t = takeLimit(uid, m.pushName, owner)
    if (!t.ok) {
      if (Date.now() - (noLimitAt.get(uid) || 0) > 60000) {
        noLimitAt.set(uid, Date.now())
        await say(noLimitText(PREFIX))
      }
      return
    }
    from = t.from
  }
  try {
    sock.sendPresenceUpdate('composing', jid).catch(() => {})
    await say(await curhat(uid, text))
  } catch (e) {
    refundLimit(uid, m.pushName, from)
    console.error('Error curhat:', e.message)
    await say(fail(e.message))
  }
}

// ---------- handler ----------
async function handle(sock, m) {
  const text = getText(m).trim()
  if (!text.startsWith(PREFIX)) {
    const jid0 = m.key.remoteJid
    if (text && !m.key.fromMe && isPrivateChat(jid0) && isCurhatOn(userIdOf(m)) && !(mode === 'private' && !isOwnerMsg(m))) {
      return curhatTurn(sock, m, text)
    }
    return checkGameAnswer(sock, m, text)
  }
  const cmd = text.slice(PREFIX.length).split(/\s+/)[0].toLowerCase()
  const jid = m.key.remoteJid
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

  const owner = isOwnerMsg(m)
  const uid = userIdOf(m)

  // limit: ambil 1 saat benar-benar mau jalan, kembalikan kalau perintahnya gagal
  let spent = null
  const useLimit = () => {
    const t = takeLimit(uid, m.pushName, owner)
    if (!t.ok) {
      reply(noLimitText(PREFIX)).catch(() => {})
      return false
    }
    spent = t.from
    return true
  }
  const giveBack = () => {
    refundLimit(uid, m.pushName, spent)
    spent = null
  }

  if (cmd === 'public' || cmd === 'private') {
    if (!owner) return reply('khusus owner.')
    mode = cmd
    saveMode()
    return reply(box('MODE', [mode === 'public' ? 'mode public, semua orang bisa pakai bot.' : 'mode private, cuma owner yang bisa pakai bot.']))
  }

  // mode private: abaikan perintah dari orang lain
  if (mode === 'private' && !owner) return

  if (['menu', 'help', 'start'].includes(cmd)) {
    return reply(menuText(text.split(/\s+/)[1], {
      name: m.pushName,
      limit: limitInfo(uid, m.pushName, owner).label,
      credit: creditOf(uid, m.pushName).toLocaleString('id-ID'),
    }))
  }

  const ctx = normalizeMessageContent(m.message)?.extendedTextMessage?.contextInfo

  if (cmd === 'curhat') {
    const arg = text.replace(/^\S+\s*/, '').trim()
    const sub = arg.toLowerCase()
    if (sub === 'off') {
      setCurhatOn(uid, false)
      return reply(box('CURHAT', ['mode curhat dimatikan.', `nyalakan lagi: ${cmdTxt('curhat')}`]))
    }
    if (sub === 'reset') {
      resetCurhat(uid)
      return reply(box('CURHAT', ['riwayat obrolan curhat dihapus.']))
    }
    if (!arg) {
      if (!isPrivateChat(jid)) {
        return reply(box('CURHAT', ['mode otomatis cuma di chat pribadi.', `di grup pakai: ${cmdTxt('curhat <ceritamu>')}`]))
      }
      setCurhatOn(uid, true)
      return reply(box('CURHAT', [
        'mode curhat aktif. cerita aja, aku dengerin.',
        `matikan: ${cmdTxt('curhat off')}`,
        `hapus riwayat: ${cmdTxt('curhat reset')}`,
      ]))
    }
    return curhatTurn(sock, m, arg)
  }

  if (cmd === 'hd') {
    const media = findMedia(m)
    if (!media || media.kind !== 'image') return reply('kirim atau reply gambar dulu.')
    if (!useLimit()) return
    try {
      const buf = await downloadMediaMessage(media.target, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      })
      await sock.sendMessage(jid, { image: await enhanceImage(buf), caption: 'hd (diperjelas)' }, { quoted: m })
    } catch (e) {
      giveBack()
      console.error('Error hd:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  if (cmd === 'brat') {
    const t = argText(text, ctx)
    if (!t) return reply(`tulis teksnya.\ncontoh: ${cmdTxt('brat halo semua')}`)
    try {
      const webp = await toSticker(await bratImage(t), 'image')
      await sock.sendMessage(jid, { sticker: webp }, { quoted: m })
    } catch (e) {
      console.error('Error brat:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  if (cmd === 'hidetag') {
    if (!jid.endsWith('@g.us')) return reply('perintah ini cuma di grup.')
    const msg = argText(text, ctx)
    if (!msg) return reply(`tulis pesannya.\ncontoh: ${cmdTxt('hidetag halo semua')}`)
    try {
      const meta = await sock.groupMetadata(jid)
      const digits = (j) => (j || '').split('@')[0].split(':')[0]
      const senders = [m.key.participant, m.key.participantAlt].filter(Boolean).map(digits)
      const isAdmin = meta.participants.some(
        (p) => p.admin && [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(digits).some((d) => senders.includes(d)),
      )
      if (!owner && !isAdmin) return reply('khusus admin grup.')
      await sock.sendMessage(jid, { text: msg, mentions: meta.participants.map((p) => p.id) })
    } catch (e) {
      console.error('Error hidetag:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  const rpgOut = rpgCommand({
    cmd,
    args: text.replace(/^\S+\s*/, '').trim(),
    id: userIdOf(m),
    name: m.pushName,
    owner,
    prefix: PREFIX,
  })
  if (rpgOut !== null) return reply(rpgOut)

  if (GAME_CMD[cmd]) {
    try {
      await startGame(sock, m, GAME_CMD[cmd])
    } catch (e) {
      console.error('Error game:', e.message)
      await reply(fail(e.message))
    }
    return
  }
  if (cmd === 'tebakvideo') return reply('tebak video belum ada, aku belum nemu sumber soal gratisnya.')
  if (cmd === 'nyerah' || cmd === 'skip') {
    const g = games.get(jid)
    if (!g) return reply('lagi nggak ada soal.')
    clearTimeout(g.timer)
    games.delete(jid)
    return reply(`jawabannya: ${g.answer}`)
  }

  if (cmd === 'owner') {
    const botNum = (sock.user?.id || '').split('@')[0].split(':')[0]
    const num = (OWNER_CONTACT || ownerDigits[0] || botNum).replace(/\D/g, '')
    if (!num) return reply('kontak owner belum diatur.')
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${OWNER_NAME}`,
      `ORG:${BOT_NAME}`,
      `TEL;type=CELL;type=VOICE;waid=${num}:+${num}`,
      'END:VCARD',
    ].join('\n')
    await sock.sendMessage(jid, { contacts: { displayName: OWNER_NAME, contacts: [{ vcard }] } }, { quoted: m })
    return reply(`owner ${BOT_NAME}\nwa.me/${num}`)
  }

  if (Object.hasOwn(REACTIONS, cmd)) {
    try {
      const { gif, anime } = await getReactionGif(cmd)
      const mp4 = await gifToMp4(gif)
      const me = m.key.participant || m.key.remoteJid
      const target = ctx?.mentionedJid?.[0] || ctx?.participant
      const num = (j) => j.split('@')[0].split(':')[0]
      let caption = ''
      let mentions = []
      if (target && target !== me) {
        caption = `@${num(me)} ${REACTIONS[cmd]} @${num(target)}`
        mentions = [me, target]
      }
      if (anime) caption += `${caption ? "\n" : ""}anime: ${anime}`
      await sock.sendMessage(jid, { video: mp4, gifPlayback: true, caption: caption || undefined, mentions }, { quoted: m })
    } catch (e) {
      console.error('Error reaksi:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  if (['play', 'ytmp3', 'yta', 'ytmp4', 'ytv'].includes(cmd)) {
    const isVideo = cmd === 'ytmp4' || cmd === 'ytv'
    let q = argText(text, ctx)
    let height = 480
    const hm = q.match(/\s+(\d{3,4})p?$/)
    if (isVideo && hm) {
      height = Math.min(720, Math.max(144, Number(hm[1])))
      q = q.slice(0, hm.index).trim()
    }
    if (!q) {
      return reply(box(cmd.toUpperCase(), [
        cmd === 'play' ? 'tulis judul lagu atau kirim link.' : 'kirim link atau judulnya.',
        `contoh: ${cmdTxt(cmd)} ${isVideo ? 'https://youtu.be/xxxx 360' : cmd === 'play' ? 'lathi weird genius' : 'https://youtu.be/xxxx'}`,
        'sumber: YouTube, SoundCloud, dan banyak situs lain.',
      ]))
    }
    if (dlBusy >= DL_MAX_PARALLEL) return reply(box('SIBUK', ['downloader lagi penuh, coba lagi sebentar.']))
    if (!useLimit()) return
    dlBusy++
    try {
      await reply(box('PROSES', [isUrl(q) ? 'ngambil dari link...' : `nyari: ${q}`, 'sebentar ya.']))
      const info = await fetchInfo(q)
      const maxSec = isVideo ? MAX_VIDEO_SEC : MAX_AUDIO_SEC
      if (info.duration > maxSec) throw new Error(`durasi ${fmtDur(info.duration)} terlalu panjang (maks ${maxSec / 60} menit).`)
      const caption = box(isVideo ? 'VIDEO' : 'MUSIK', [
        `judul: ${info.title}`,
        info.uploader && `channel: ${info.uploader}`,
        info.duration > 0 && `durasi: ${fmtDur(info.duration)}`,
        info.source && `sumber: ${info.source}`,
        isVideo && `kualitas: maks ${height}p`,
      ])
      const fileName = info.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80)
      if (isVideo) {
        const { buf } = await downloadVideo(info.url, height)
        await sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption, fileName: `${fileName}.mp4` }, { quoted: m })
      } else {
        let sent = false
        if (info.thumb) {
          try {
            await sock.sendMessage(jid, { image: { url: info.thumb }, caption }, { quoted: m })
            sent = true
          } catch {}
        }
        if (!sent) await reply(caption)
        const { buf } = await downloadAudio(info.url)
        await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', fileName: `${fileName}.mp3` }, { quoted: m })
      }
    } catch (e) {
      giveBack()
      console.error(`Error ${cmd}:`, e.message)
      await reply(fail(e.message))
    } finally {
      dlBusy--
    }
    return
  }

  if (['tt', 'tiktok', 'ttdl'].includes(cmd)) {
    const q = normalizeMessageContent(ctx?.quotedMessage)
    const hay = `${text} ${q?.conversation || ''} ${q?.extendedTextMessage?.text || ''}`
    const link = hay.match(/https?:\/\/[^\s]*tiktok\.com[^\s]*/i)?.[0]
    if (!link) return reply(`mana link tiktok-nya?\ncontoh: ${cmdTxt('tt https://vt.tiktok.com/xxxx')}`)
    if (!useLimit()) return
    try {
      const info = await tiktokDl(link)
      const caption = [info.author && `@${info.author}`, info.title].filter(Boolean).join('\n').slice(0, 900)
      if (info.images.length) {
        // slideshow foto: kirim maksimal 10 gambar
        for (const [i, u] of info.images.slice(0, 10).entries()) {
          await sock.sendMessage(jid, { image: await downloadBuffer(u), caption: i === 0 ? caption : undefined }, { quoted: m })
        }
      } else if (info.video) {
        await sock.sendMessage(jid, { video: await downloadBuffer(info.video), mimetype: 'video/mp4', caption }, { quoted: m })
      } else {
        throw new Error('Link video nggak ditemukan.')
      }
    } catch (e) {
      giveBack()
      console.error('Error tiktok:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  if (Object.hasOwn(ANIME_CMDS, cmd)) {
    try {
      const { url, caption } = await getAnimeImage(ANIME_CMDS[cmd])
      await sock.sendMessage(jid, { image: { url }, caption: caption || undefined }, { quoted: m })
    } catch (e) {
      console.error('Error anime:', e.message)
      await reply(fail(e.message))
    }
    return
  }

  const isSticker = ['s', 'sticker', 'stiker'].includes(cmd)
  const isSoundSticker = ['sa', 'soundsticker'].includes(cmd)
  const isStickerAudio = ['sa2', 'stickeraudio'].includes(cmd)
  const isAudio = ['mp3', 'audio', 'toaudio'].includes(cmd)
  if (!isSticker && !isSoundSticker && !isStickerAudio && !isAudio) return

  const media = findMedia(m)
  if (!media) return reply(`kirim atau reply gambar/video dulu. ketik ${cmdTxt('menu')} buat daftar perintah.`)
  if ((isSoundSticker || isStickerAudio || isAudio) && media.kind !== 'video') {
    return reply('perintah ini cuma buat video.')
  }

  await sock.sendPresenceUpdate('composing', jid).catch(() => {})
  try {
    const buf = await downloadMediaMessage(media.target, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    })

    if (isSoundSticker) {
      await sendSoundSticker(sock, jid, buf)
    }
    if (isSticker || isStickerAudio) {
      const webp = await toSticker(buf, media.kind)
      await sock.sendMessage(jid, { sticker: webp }, { quoted: m })
    }
    if (isStickerAudio || isAudio) {
      const mp3 = await toAudio(buf, isStickerAudio ? MAX_SECONDS : 0)
      await sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: m })
    }
  } catch (e) {
    console.error('Error:', e.message)
    await reply(fail(e.message))
  }
}

// ---------- koneksi ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // nilai ini dipakai karena nama browser kustom sering bikin pairing code ditolak
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  const rawSend = sock.sendMessage.bind(sock)
  sock.sendMessage = (jid, content, opts) => {
    rememberBotText(content?.text || content?.caption)
    return rawSend(jid, content, opts)
  }

  // Login pakai pairing code (tanpa scan QR)
  if (!sock.authState.creds.registered) {
    const number = (process.env.PHONE_NUMBER || (await ask('Masukkan nomor WA bot (contoh 6281234567890): ')))
      .replace(/\D/g, '')
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number)
        console.log(`\n🔑 Pairing code kamu: ${code?.match(/.{1,4}/g)?.join('-') ?? code}`)
        console.log('Buka WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon, lalu masukkan kode di atas.\n')
      } catch (e) {
        console.error('Gagal minta pairing code:', e.message)
      }
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('bot tersambung')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Sesi logout. Hapus folder "auth" lalu jalankan ulang untuk pairing lagi.')
        process.exit(1)
      }
      console.log('Koneksi putus, menyambung ulang...')
      setTimeout(start, 2000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (!m.message || m.key.remoteJid === 'status@broadcast') continue
      handle(sock, m).catch((e) => console.error(e))
    }
  })
}

start()
