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
import path from 'node:path'

// ================= PENGATURAN =================
const PREFIX = '.'
const MAX_SECONDS = 10 // durasi maksimal video jadi stiker
const MAX_STICKER_BYTES = 900 * 1000 // batas WA ~1MB untuk stiker animasi
// ==============================================

const logger = pino({ level: 'silent' })

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

// ---------- konversi ----------
async function toSticker(buffer, kind) {
  return withTmp(async (dir) => {
    const inp = path.join(dir, 'in.bin')
    const out = path.join(dir, 'out.webp')
    await writeFile(inp, buffer)

    const vf =
      (kind === 'video' ? 'fps=15,' : '') +
      'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,' +
      'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'

    let result
    for (const q of [60, 45, 30, 20, 10]) {
      const args = ['-y', '-i', inp]
      if (kind === 'video') args.push('-t', String(MAX_SECONDS))
      args.push('-vf', vf, '-an', '-vcodec', 'libwebp', '-lossless', '0',
        '-q:v', String(q), '-compression_level', '6', '-loop', '0', out)
      await run('ffmpeg', args)
      result = await readFile(out)
      if (result.length <= MAX_STICKER_BYTES) return result
    }
    throw new Error('Hasil stiker kebesaran (>1MB). Coba video yang lebih pendek/sederhana.')
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
  const webp = await toSticker(videoBuf, 'video')
  const { buf: ogg, seconds } = await toOpus(videoBuf, MAX_SECONDS)
  const up = { upload: sock.waUploadToServer }

  const { stickerMessage } = await prepareWAMessageMedia({ sticker: webp }, up)
  const { audioMessage } = await prepareWAMessageMedia(
    { audio: ogg, mimetype: 'audio/ogg; codecs=opus', seconds }, up)

  const sBytes = proto.Message.StickerMessage.encode(
    proto.Message.StickerMessage.fromObject({ ...stickerMessage, isAnimated: true, width: 512, height: 512 })).finish()
  const aBytes = proto.Message.AudioMessage.encode(
    proto.Message.AudioMessage.fromObject({ ...audioMessage, ptt: false, seconds })).finish()

  const stickerWithAudio = Buffer.concat([sBytes, lenField(26, aBytes)]) // StickerMessage.audioMessage = 26
  const future = lenField(1, lenField(26, stickerWithAudio)) // FutureProofMessage.message{ stickerMessage=26 }

  await sock.relayMessage(jid, { [RAW_AUDIO_STICKER]: future }, { messageId: generateMessageID() })
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

const MENU = `*🤖 Bot Stiker*

${PREFIX}s  → gambar/video jadi stiker
${PREFIX}sa → video jadi stiker BERSUARA (sound sticker, 1 pesan)
${PREFIX}sa2 → cadangan: stiker + audio dikirim terpisah
${PREFIX}mp3 → ambil audio dari video

Cara pakai: kirim gambar/video dengan caption perintah, atau reply gambar/video pakai perintahnya.
Video maksimal ${MAX_SECONDS} detik buat stiker.
_Sound sticker cuma kelihatan di WhatsApp versi terbaru. Kalau nggak muncul, pakai ${PREFIX}sa2._`

// ---------- handler ----------
async function handle(sock, m) {
  const text = getText(m).trim()
  if (!text.startsWith(PREFIX)) return
  const cmd = text.slice(PREFIX.length).split(/\s+/)[0].toLowerCase()
  const jid = m.key.remoteJid
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

  if (['menu', 'help', 'start'].includes(cmd)) return reply(MENU)

  const isSticker = ['s', 'sticker', 'stiker'].includes(cmd)
  const isSoundSticker = ['sa', 'soundsticker'].includes(cmd)
  const isStickerAudio = ['sa2', 'stickeraudio'].includes(cmd)
  const isAudio = ['mp3', 'audio', 'toaudio'].includes(cmd)
  if (!isSticker && !isSoundSticker && !isStickerAudio && !isAudio) return

  const media = findMedia(m)
  if (!media) return reply(`Kirim/reply gambar atau video dulu ya. Ketik ${PREFIX}menu buat bantuan.`)
  if ((isSoundSticker || isStickerAudio || isAudio) && media.kind !== 'video') {
    return reply('Perintah ini cuma buat video.')
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
    await reply(`❌ Gagal: ${e.message}`)
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
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

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
    if (connection === 'open') console.log('✅ Bot tersambung!')
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
