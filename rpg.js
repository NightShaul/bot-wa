// Modul ekonomi + RPG + sistem limit untuk bot WA: credit, nambang, pet, battle, limit harian, premium, toko.
// Data disimpan di rpg.json (di folder yang sama dengan index.js).
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { box, fmt } from './ui.js'

// ---------- pengaturan limit (ubah sesuka hati) ----------
export const DAILY_LIMIT = 20 // jatah gratis per hari untuk user non-premium
export const LIMIT_PACK = 100 // 1 paket di toko = 100 limit
export const LIMIT_PRICE = 50 // harga 1 paket = 50 credit
const MAX_BUY = 10000 // maksimal limit sekali beli

const FILE = 'rpg.json'
let db = { users: {} }
try {
  db = JSON.parse(readFileSync(FILE, 'utf8'))
  db.users ||= {}
} catch {}

let timer = null
export function flush() {
  try {
    writeFileSync(FILE + '.tmp', JSON.stringify(db))
    renameSync(FILE + '.tmp', FILE)
  } catch (e) {
    console.error('gagal simpan rpg.json:', e.message)
  }
}
const save = () => {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flush()
  }, 1500)
}
process.on('exit', flush)
process.on('SIGINT', () => {
  flush()
  process.exit(0)
})

// ---------- pengguna ----------
// id pengguna: utamakan nomor telepon (@s.whatsapp.net) supaya akun nggak kepisah antara chat pribadi & grup
export function userIdOf(m) {
  const ids = [m.key.participantAlt, m.key.remoteJidAlt, m.key.participant, m.key.remoteJid].filter(Boolean)
  const best = ids.find((j) => j.endsWith('@s.whatsapp.net')) || ids[0] || 'unknown'
  return best.split('@')[0].split(':')[0]
}

// hari berganti jam 00:00 WIB
const WIB = 7 * 3600 * 1000
const dayKey = () => new Date(Date.now() + WIB).toISOString().slice(0, 10)

function getUser(id, name) {
  const u = (db.users[id] ||= {
    credit: 0,
    pick: 1,
    ores: { batu: 0, besi: 0, emas: 0, berlian: 0 },
    pet: null,
    cd: {},
    wins: 0,
    losses: 0,
    name: '',
  })
  // field baru (aman untuk data lama)
  u.bonus ??= 0 // limit hasil beli, nggak ikut reset harian
  u.premium ??= 0 // timestamp berakhirnya premium
  u.lim ??= { day: '', used: 0 }
  if (u.lim.day !== dayKey()) u.lim = { day: dayKey(), used: 0 }
  if (name) u.name = name
  return u
}

export function addCredit(id, name, n) {
  const u = getUser(id, name)
  u.credit += n
  save()
  return u.credit
}
export const creditOf = (id, name) => getUser(id, name).credit

// ---------- limit & premium ----------
const isPrem = (u) => u.premium > Date.now()

function durText(ms) {
  const d = Math.floor(ms / 864e5)
  const h = Math.floor((ms % 864e5) / 36e5)
  const mnt = Math.floor((ms % 36e5) / 6e4)
  return d ? `${d} hari ${h} jam` : `${h} jam ${mnt} menit`
}

export function limitInfo(id, name, owner) {
  const u = getUser(id, name)
  if (owner) return { unlimited: true, label: 'unlimited (owner)' }
  if (isPrem(u)) return { unlimited: true, label: `unlimited (premium, sisa ${durText(u.premium - Date.now())})` }
  const left = Math.max(0, DAILY_LIMIT - u.lim.used)
  return {
    unlimited: false,
    left,
    bonus: u.bonus,
    label: `${left}/${DAILY_LIMIT}${u.bonus ? ` + ${fmt(u.bonus)} bonus` : ''}`,
  }
}

// Pakai 1 limit. Urutan: jatah harian dulu, baru limit bonus (hasil beli).
export function takeLimit(id, name, owner) {
  const u = getUser(id, name)
  if (owner || isPrem(u)) return { ok: true, from: null }
  if (u.lim.used < DAILY_LIMIT) {
    u.lim.used++
    save()
    return { ok: true, from: 'daily' }
  }
  if (u.bonus > 0) {
    u.bonus--
    save()
    return { ok: true, from: 'bonus' }
  }
  return { ok: false }
}

// Kembalikan limit kalau perintahnya gagal.
export function refundLimit(id, name, from) {
  if (!from) return
  const u = getUser(id, name)
  if (from === 'daily') u.lim.used = Math.max(0, u.lim.used - 1)
  else u.bonus++
  save()
}

export function noLimitText(prefix = '.') {
  return box('LIMIT HABIS', [
    `jatah gratis ${DAILY_LIMIT} limit/hari sudah habis.`,
    'reset otomatis jam 00:00 WIB.',
    '',
    `beli limit: ${prefix}buylimit  (${LIMIT_PACK} limit = ${LIMIT_PRICE} credit)`,
    `cari credit: ${prefix}daily, ${prefix}nambang, ${prefix}battle`,
    'atau jadi premium (unlimited): hubungi owner.',
  ])
}

// ---------- util ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
function weighted(items) {
  const total = items.reduce((s, i) => s + i.w, 0)
  let r = Math.random() * total
  for (const i of items) {
    if ((r -= i.w) < 0) return i
  }
  return items[items.length - 1]
}
function cooldown(u, key, ms) {
  const left = (u.cd[key] || 0) + ms - Date.now()
  if (left > 0) {
    const s = Math.ceil(left / 1000)
    if (s >= 3600) return `${Math.floor(s / 3600)} jam ${Math.floor((s % 3600) / 60)} menit`
    if (s >= 60) return `${Math.floor(s / 60)} menit ${s % 60} detik`
    return `${s} detik`
  }
  u.cd[key] = Date.now()
  return null
}

// ---------- data game ----------
const ORES = [
  { id: 'batu', value: 1 },
  { id: 'besi', value: 2 },
  { id: 'emas', value: 5 },
  { id: 'berlian', value: 15 },
]
const PICK_PRICE = { 2: 80, 3: 250, 4: 700, 5: 2000 }
const MAX_PICK = 5
const PICK_NAME = { 1: 'kayu', 2: 'batu', 3: 'besi', 4: 'emas', 5: 'berlian' }

const SPECIES = [
  { id: 'kucing', w: 30, hp: 0, atk: 2, rarity: 'common' },
  { id: 'anjing', w: 30, hp: 5, atk: 1, rarity: 'common' },
  { id: 'slime', w: 20, hp: 10, atk: 0, rarity: 'common' },
  { id: 'serigala', w: 12, hp: 5, atk: 4, rarity: 'rare' },
  { id: 'naga', w: 6, hp: 15, atk: 6, rarity: 'epic' },
  { id: 'phoenix', w: 2, hp: 20, atk: 9, rarity: 'legendary' },
]
const MONSTERS = ['goblin', 'kelelawar', 'zombie', 'orc', 'troll', 'golem', 'hantu', 'laba-laba raksasa']
const ADOPT_PRICE = 20
const FEED_PRICE = 5
const FEED_XP = 15

const petStats = (p) => {
  const sp = SPECIES.find((s) => s.id === p.species)
  return { hp: 40 + p.level * 12 + sp.hp, atk: 6 + p.level * 2 + sp.atk }
}
const xpNeed = (lv) => lv * 30

function giveXp(p, xp) {
  p.xp += xp
  let up = 0
  while (p.xp >= xpNeed(p.level)) {
    p.xp -= xpNeed(p.level)
    p.level++
    up++
  }
  return up
}

// ---------- perintah ----------
// Mengembalikan teks balasan, atau null kalau perintahnya bukan milik modul ini.
export function rpgCommand({ cmd, args, id, name, owner, prefix = '.' }) {
  const c = (x) => `${prefix}${x}`
  const u = () => getUser(id, name)

  if (['balance', 'bal', 'credit', 'saldo', 'me', 'profile', 'profil'].includes(cmd)) {
    const me = u()
    const ores = ORES.filter((o) => me.ores[o.id] > 0)
      .map((o) => `${o.id} x${me.ores[o.id]}`)
      .join(', ')
    const pet = me.pet ? `${me.pet.name} (${me.pet.species}, lv${me.pet.level})` : 'belum punya'
    return box('PROFIL', [
      `nama: ${me.name || 'kamu'}`,
      `credit: ${fmt(me.credit)}`,
      `limit: ${limitInfo(id, name, owner).label}`,
      `beliung: ${PICK_NAME[me.pick]} (lv${me.pick})`,
      `hasil tambang: ${ores || '-'}`,
      `pet: ${pet}`,
      `battle: ${me.wins} menang / ${me.losses} kalah`,
    ])
  }

  // ----- limit & premium -----
  if (cmd === 'limit' || cmd === 'ceklimit') {
    const li = limitInfo(id, name, owner)
    return box('LIMIT', [
      `limit kamu: ${li.label}`,
      !li.unlimited && `jatah harian ${DAILY_LIMIT}, reset jam 00:00 WIB`,
      !li.unlimited && 'limit bonus (hasil beli) nggak hangus.',
      '',
      'dipakai untuk: play, ytmp3, ytmp4, tt, hd',
      !li.unlimited && `beli limit: ${c('buylimit')} (${LIMIT_PACK} limit = ${LIMIT_PRICE} credit)`,
    ])
  }

  if (cmd === 'buylimit' || cmd === 'belilimit') {
    const me = u()
    if (limitInfo(id, name, owner).unlimited) return box('LIMIT', ['kamu sudah unlimited, nggak perlu beli limit.'])
    const amount = args ? parseInt(args, 10) : LIMIT_PACK
    if (!Number.isFinite(amount) || amount < LIMIT_PACK || amount % LIMIT_PACK !== 0 || amount > MAX_BUY) {
      return box('BELI LIMIT', [
        `harga: ${LIMIT_PACK} limit = ${LIMIT_PRICE} credit`,
        `jumlah harus kelipatan ${LIMIT_PACK} (maks ${fmt(MAX_BUY)}).`,
        `contoh: ${c('buylimit 100')} atau ${c('buylimit 300')}`,
      ])
    }
    const price = (amount / LIMIT_PACK) * LIMIT_PRICE
    if (me.credit < price) {
      return box('CREDIT KURANG', [`butuh ${fmt(price)} credit, kamu punya ${fmt(me.credit)}.`])
    }
    me.credit -= price
    me.bonus += amount
    save()
    return box('BERHASIL BELI', [
      `+${fmt(amount)} limit (-${fmt(price)} credit)`,
      `limit bonus: ${fmt(me.bonus)}`,
      `sisa credit: ${fmt(me.credit)}`,
    ])
  }

  // owner: .addprem <nomor> [hari]   |   .delprem <nomor>
  if (cmd === 'addprem' || cmd === 'delprem') {
    if (!owner) return 'khusus owner.'
    const [num, d] = args.split(/\s+/)
    const target = String(num || '').replace(/\D/g, '')
    if (!target) return box('PREMIUM', [`format: ${c('addprem 628xxx 30')}`, `hapus: ${c('delprem 628xxx')}`])
    const t = getUser(target)
    if (cmd === 'delprem') {
      t.premium = 0
      save()
      return box('PREMIUM', [`premium ${target} dicabut.`])
    }
    const days = d ? parseInt(d, 10) : 30
    if (!Number.isFinite(days) || days < 1 || days > 3650) return box('PREMIUM', ['jumlah hari harus 1 - 3650.'])
    t.premium = Math.max(Date.now(), t.premium) + days * 864e5
    save()
    return box('PREMIUM', [`${target} premium +${days} hari`, `sisa: ${durText(t.premium - Date.now())}`])
  }

  if (cmd === 'daily' || cmd === 'harian') {
    const me = u()
    const left = cooldown(me, 'daily', 24 * 3600 * 1000)
    if (left) return box('DAILY', [`sudah diambil. coba lagi ${left} lagi.`])
    const n = rand(8, 12)
    me.credit += n
    save()
    return box('DAILY', [`+${n} credit`, `total: ${fmt(me.credit)}`])
  }

  if (cmd === 'nambang' || cmd === 'mine') {
    const me = u()
    const left = cooldown(me, 'mine', 60 * 1000)
    if (left) return box('NAMBANG', [`beliungmu masih capek. tunggu ${left}.`])
    const L = me.pick
    const table = [
      { ...ORES[0], w: Math.max(25, 60 - 8 * (L - 1)) },
      { ...ORES[1], w: 25 },
      { ...ORES[2], w: 12 + 3 * (L - 1) },
      { ...ORES[3], w: 3 + 2.5 * (L - 1) },
    ]
    const count = rand(1, 1 + L)
    const got = {}
    for (let i = 0; i < count; i++) {
      const o = weighted(table)
      got[o.id] = (got[o.id] || 0) + 1
      me.ores[o.id]++
    }
    save()
    const list = Object.entries(got)
      .map(([k, v]) => `${k} x${v}`)
      .join(', ')
    return box('NAMBANG', [`beliung ${PICK_NAME[L]}`, `dapat: ${list}`, `ketik ${c('jual')} buat jual jadi credit.`])
  }

  if (cmd === 'jual' || cmd === 'sell') {
    const me = u()
    let total = 0
    let n = 0
    for (const o of ORES) {
      total += me.ores[o.id] * o.value
      n += me.ores[o.id]
      me.ores[o.id] = 0
    }
    if (!n) return box('JUAL', [`nggak ada yang dijual. ${c('nambang')} dulu.`])
    me.credit += total
    save()
    return box('JUAL', [`${n} hasil tambang terjual`, `+${fmt(total)} credit`, `total: ${fmt(me.credit)}`])
  }

  if (cmd === 'shop' || cmd === 'toko') {
    const me = u()
    const next =
      me.pick < MAX_PICK
        ? `${c('upgrade')} - beliung ${PICK_NAME[me.pick + 1]}: ${fmt(PICK_PRICE[me.pick + 1])} credit`
        : 'beliung sudah maksimal'
    return box('TOKO', [
      `◦ ${next}`,
      `◦ ${c('buylimit <jumlah>')} - ${LIMIT_PACK} limit = ${LIMIT_PRICE} credit`,
      `◦ ${c('adopt')} - adopsi pet acak: ${ADOPT_PRICE} credit`,
      `◦ ${c('feed')} - kasih makan pet: ${FEED_PRICE} credit (+${FEED_XP} xp)`,
      '',
      `credit kamu: ${fmt(me.credit)}`,
      `limit kamu: ${limitInfo(id, name, owner).label}`,
    ])
  }

  if (cmd === 'upgrade') {
    const me = u()
    if (me.pick >= MAX_PICK) return box('UPGRADE', ['beliungmu sudah level maksimal.'])
    const price = PICK_PRICE[me.pick + 1]
    if (me.credit < price) return box('UPGRADE', [`credit kurang. butuh ${fmt(price)}, kamu punya ${fmt(me.credit)}.`])
    me.credit -= price
    me.pick++
    save()
    return box('UPGRADE', [`beliung naik jadi ${PICK_NAME[me.pick]} (lv${me.pick})`, `sisa credit: ${fmt(me.credit)}`])
  }

  if (cmd === 'adopt') {
    const me = u()
    if (me.pet) return box('ADOPT', [`kamu sudah punya pet: ${me.pet.name}.`])
    if (me.credit < ADOPT_PRICE) return box('ADOPT', [`credit kurang. butuh ${ADOPT_PRICE}, kamu punya ${fmt(me.credit)}.`])
    const sp = weighted(SPECIES)
    me.credit -= ADOPT_PRICE
    me.pet = { species: sp.id, name: sp.id, level: 1, xp: 0 }
    save()
    return box('ADOPT', [`kamu dapat ${sp.id} (${sp.rarity})!`, `ganti nama: ${c('rename <nama>')}`, `sisa credit: ${fmt(me.credit)}`])
  }

  if (cmd === 'pet') {
    const me = u()
    if (!me.pet) return box('PET', [`kamu belum punya pet. ${c('adopt')} (${ADOPT_PRICE} credit).`])
    const p = me.pet
    const st = petStats(p)
    const sp = SPECIES.find((s) => s.id === p.species)
    return box(`PET: ${p.name}`, [
      `jenis: ${p.species} (${sp.rarity})`,
      `level: ${p.level}  xp: ${p.xp}/${xpNeed(p.level)}`,
      `hp: ${st.hp}  atk: ${st.atk}`,
    ])
  }

  if (cmd === 'rename') {
    const me = u()
    if (!me.pet) return box('PET', ['kamu belum punya pet.'])
    const n = args.replace(/\s+/g, ' ').trim().slice(0, 20)
    if (!n) return box('RENAME', [`tulis namanya. contoh: ${c('rename Mochi')}`])
    me.pet.name = n
    save()
    return box('PET', [`nama pet sekarang: ${n}`])
  }

  if (cmd === 'feed') {
    const me = u()
    if (!me.pet) return box('FEED', ['kamu belum punya pet.'])
    if (me.credit < FEED_PRICE) return box('FEED', [`credit kurang. butuh ${FEED_PRICE}.`])
    me.credit -= FEED_PRICE
    const up = giveXp(me.pet, FEED_XP)
    save()
    return box('FEED', [
      `${me.pet.name} makan dengan lahap (+${FEED_XP} xp)`,
      up && `naik ke level ${me.pet.level}!`,
      `sisa credit: ${fmt(me.credit)}`,
    ])
  }

  if (cmd === 'battle' || cmd === 'hunt') {
    const me = u()
    if (!me.pet) return box('BATTLE', [`kamu belum punya pet. ${c('adopt')} (${ADOPT_PRICE} credit).`])
    const left = cooldown(me, 'battle', 60 * 1000)
    if (left) return box('BATTLE', [`petmu lagi istirahat. tunggu ${left}.`])
    const p = me.pet
    const st = petStats(p)
    const mLv = Math.max(1, p.level + rand(-1, 2))
    const mName = MONSTERS[rand(0, MONSTERS.length - 1)]
    let mHp = 35 + mLv * 10
    const mAtk = 5 + mLv * 2
    let hp = st.hp
    let rounds = 0
    while (hp > 0 && mHp > 0 && rounds < 30) {
      rounds++
      mHp -= Math.max(1, Math.round(st.atk * (0.8 + Math.random() * 0.4)))
      if (mHp <= 0) break
      hp -= Math.max(1, Math.round(mAtk * (0.8 + Math.random() * 0.4)))
    }
    const head = [`${p.name} (lv${p.level}) vs ${mName} (lv${mLv})`, `${rounds} ronde`, '']
    if (mHp <= 0) {
      const reward = 2 + mLv + rand(0, 2)
      const xp = 10 + mLv * 3
      me.credit += reward
      me.wins++
      const up = giveXp(p, xp)
      save()
      return box('BATTLE', [
        ...head,
        `${p.name} menang! sisa hp ${Math.max(hp, 0)}/${st.hp}`,
        `+${reward} credit, +${xp} xp`,
        up && `${p.name} naik ke level ${p.level}!`,
      ])
    }
    me.losses++
    giveXp(p, 4)
    save()
    return box('BATTLE', [...head, `${p.name} kalah dari ${mName}. +4 xp buat hiburan.`, `coba ${c('feed')} biar makin kuat.`])
  }

  if (cmd === 'top' || cmd === 'leaderboard' || cmd === 'lb') {
    const list = Object.entries(db.users)
      .filter(([, v]) => v.credit > 0)
      .sort((a, b) => b[1].credit - a[1].credit)
      .slice(0, 10)
    if (!list.length) return box('TOP CREDIT', ['belum ada data.'])
    return box('TOP CREDIT', list.map(([k, v], i) => `${i + 1}. ${v.name || k} - ${fmt(v.credit)}`))
  }

  // owner: .givecredit <nomor> <jumlah>  (jumlah boleh negatif)
  if (cmd === 'givecredit') {
    if (!owner) return 'khusus owner.'
    const [num, amt] = args.split(/\s+/)
    const n = parseInt(amt, 10)
    const target = String(num || '').replace(/\D/g, '')
    if (!target || !Number.isFinite(n)) return box('GIVE CREDIT', [`format: ${c('givecredit 628xxx 100')}`])
    const t = getUser(target)
    t.credit += n
    save()
    return box('GIVE CREDIT', [`credit ${target} sekarang ${fmt(t.credit)}`])
  }

  return null
    }
