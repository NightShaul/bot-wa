// Modul ekonomi + RPG sederhana untuk bot WA: credit, nambang, pet, battle.
// Data disimpan di rpg.json (di folder yang sama dengan index.js).
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

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
  if (name) u.name = name
  return u
}

export function addCredit(id, name, n) {
  const u = getUser(id, name)
  u.credit += n
  save()
  return u.credit
}

// ---------- util ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const fmt = (n) => Number(n).toLocaleString('id-ID')
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
    return [
      `*${me.name || 'kamu'}*`,
      `credit: ${fmt(me.credit)}`,
      `beliung: ${PICK_NAME[me.pick]} (lv${me.pick})`,
      `hasil tambang: ${ores || '-'}`,
      `pet: ${pet}`,
      `battle: ${me.wins} menang / ${me.losses} kalah`,
    ].join('\n')
  }

  if (cmd === 'daily' || cmd === 'harian') {
    const me = u()
    const left = cooldown(me, 'daily', 24 * 3600 * 1000)
    if (left) return `daily sudah diambil. coba lagi ${left} lagi.`
    const n = rand(8, 12)
    me.credit += n
    save()
    return `daily: +${n} credit\ntotal: ${fmt(me.credit)}`
  }

  if (cmd === 'nambang' || cmd === 'mine') {
    const me = u()
    const left = cooldown(me, 'mine', 60 * 1000)
    if (left) return `beliungmu masih capek. tunggu ${left}.`
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
    return `nambang pakai beliung ${PICK_NAME[L]}...\ndapat: ${list}\nketik ${c('jual')} buat jual jadi credit.`
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
    if (!n) return `nggak ada yang dijual. ${c('nambang')} dulu.`
    me.credit += total
    save()
    return `jual ${n} hasil tambang: +${fmt(total)} credit\ntotal: ${fmt(me.credit)}`
  }

  if (cmd === 'shop' || cmd === 'toko') {
    const me = u()
    const next = me.pick < MAX_PICK ? `${c('upgrade')} - beliung ${PICK_NAME[me.pick + 1]}: ${fmt(PICK_PRICE[me.pick + 1])} credit` : 'beliung sudah maksimal'
    return [
      '*TOKO*',
      next,
      `${c('adopt')} - adopsi pet acak: ${ADOPT_PRICE} credit`,
      `${c('feed')} - kasih makan pet: ${FEED_PRICE} credit (+${FEED_XP} xp)`,
      '',
      `credit kamu: ${fmt(me.credit)}`,
    ].join('\n')
  }

  if (cmd === 'upgrade') {
    const me = u()
    if (me.pick >= MAX_PICK) return 'beliungmu sudah level maksimal.'
    const price = PICK_PRICE[me.pick + 1]
    if (me.credit < price) return `credit kurang. butuh ${fmt(price)}, kamu punya ${fmt(me.credit)}.`
    me.credit -= price
    me.pick++
    save()
    return `beliung naik jadi ${PICK_NAME[me.pick]} (lv${me.pick}). sisa credit: ${fmt(me.credit)}`
  }

  if (cmd === 'adopt') {
    const me = u()
    if (me.pet) return `kamu sudah punya pet: ${me.pet.name}.`
    if (me.credit < ADOPT_PRICE) return `credit kurang. butuh ${ADOPT_PRICE}, kamu punya ${fmt(me.credit)}.`
    const sp = weighted(SPECIES)
    me.credit -= ADOPT_PRICE
    me.pet = { species: sp.id, name: sp.id, level: 1, xp: 0 }
    save()
    return `kamu dapat ${sp.id} (${sp.rarity})!\nganti nama: ${c('rename <nama>')}\nsisa credit: ${fmt(me.credit)}`
  }

  if (cmd === 'pet') {
    const me = u()
    if (!me.pet) return `kamu belum punya pet. ${c('adopt')} (${ADOPT_PRICE} credit).`
    const p = me.pet
    const st = petStats(p)
    const sp = SPECIES.find((s) => s.id === p.species)
    return [
      `*${p.name}* (${p.species}, ${sp.rarity})`,
      `level: ${p.level}  xp: ${p.xp}/${xpNeed(p.level)}`,
      `hp: ${st.hp}  atk: ${st.atk}`,
    ].join('\n')
  }

  if (cmd === 'rename') {
    const me = u()
    if (!me.pet) return 'kamu belum punya pet.'
    const n = args.replace(/\s+/g, ' ').trim().slice(0, 20)
    if (!n) return `tulis namanya. contoh: ${c('rename Mochi')}`
    me.pet.name = n
    save()
    return `nama pet sekarang: ${n}`
  }

  if (cmd === 'feed') {
    const me = u()
    if (!me.pet) return 'kamu belum punya pet.'
    if (me.credit < FEED_PRICE) return `credit kurang. butuh ${FEED_PRICE}.`
    me.credit -= FEED_PRICE
    const up = giveXp(me.pet, FEED_XP)
    save()
    return `${me.pet.name} makan dengan lahap (+${FEED_XP} xp).${up ? `\nnaik ke level ${me.pet.level}!` : ''}\nsisa credit: ${fmt(me.credit)}`
  }

  if (cmd === 'battle' || cmd === 'hunt') {
    const me = u()
    if (!me.pet) return `kamu belum punya pet. ${c('adopt')} (${ADOPT_PRICE} credit).`
    const left = cooldown(me, 'battle', 60 * 1000)
    if (left) return `petmu lagi istirahat. tunggu ${left}.`
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
    const head = `${p.name} (lv${p.level}) vs ${mName} (lv${mLv})\n${rounds} ronde.`
    if (mHp <= 0) {
      const reward = 2 + mLv + rand(0, 2)
      const xp = 10 + mLv * 3
      me.credit += reward
      me.wins++
      const up = giveXp(p, xp)
      save()
      return `${head}\n${p.name} menang! sisa hp ${Math.max(hp, 0)}/${st.hp}\n+${reward} credit, +${xp} xp${up ? `\n${p.name} naik ke level ${p.level}!` : ''}`
    }
    me.losses++
    giveXp(p, 4)
    save()
    return `${head}\n${p.name} kalah dari ${mName}. +4 xp buat hiburan.\ncoba ${c('feed')} biar makin kuat.`
  }

  if (cmd === 'top' || cmd === 'leaderboard' || cmd === 'lb') {
    const list = Object.entries(db.users)
      .sort((a, b) => b[1].credit - a[1].credit)
      .slice(0, 10)
    if (!list.length) return 'belum ada data.'
    return ['*TOP CREDIT*', ...list.map(([k, v], i) => `${i + 1}. ${v.name || k} - ${fmt(v.credit)}`)].join('\n')
  }

  // owner: .givecredit <nomor> <jumlah>  (jumlah boleh negatif)
  if (cmd === 'givecredit') {
    if (!owner) return 'khusus owner.'
    const [num, amt] = args.split(/\s+/)
    const n = parseInt(amt, 10)
    const target = String(num || '').replace(/\D/g, '')
    if (!target || !Number.isFinite(n)) return `format: ${c('givecredit 628xxx 100')}`
    const t = getUser(target)
    t.credit += n
    save()
    return `credit ${target} sekarang ${fmt(t.credit)}`
  }

  return null
}