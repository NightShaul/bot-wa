# Bot WA Stiker

Fitur:
- `.s` → gambar / video jadi stiker (video jadi stiker animasi, maks 10 detik)
- `.sa` → video jadi **sound sticker** (stiker animasi + suara dalam 1 pesan, tap ikon speaker buat bunyi)
- `.sa2` → cadangan: stiker animasi + audio dikirim terpisah (2 pesan)
- `.mp3` → ambil audio dari video
- `.menu` → bantuan

Pakai: kirim gambar/video dengan caption perintah, atau reply gambar/video dengan perintahnya.

> `.sa` memakai format sound sticker WhatsApp yang baru (belum didukung resmi oleh Baileys), jadi
> ditulis manual di `index.js`. Fitur ini EKSPERIMENTAL dan belum dites langsung. Kalau stikernya
> tidak muncul di penerima, pakai `.sa2`. Penerima juga harus pakai WhatsApp versi terbaru.

## Persiapan

1. Install **Node.js 18+** dan **ffmpeg**
   - Windows: `winget install ffmpeg` (atau download dari ffmpeg.org)
   - Termux (Android): `pkg install nodejs ffmpeg`
   - Linux: `sudo apt install nodejs npm ffmpeg`
2. Di folder ini jalankan:
   ```
   npm install
   npm start
   ```
3. Masukkan nomor WA bot (format `62812xxxx`, tanpa + atau spasi).
4. Muncul pairing code → di HP buka WhatsApp > Perangkat tertaut > Tautkan perangkat > **Tautkan dengan nomor telepon** → masukkan kodenya.
5. Selesai. Sesi tersimpan di folder `auth/`, jadi next run nggak perlu pairing lagi.

Kalau mau lewati prompt nomor: `PHONE_NUMBER=62812xxxx npm start`

## Catatan
- Kalau muncul "Sesi logout", hapus folder `auth/` lalu jalankan ulang.
- Pengaturan (prefix, durasi maks) ada di bagian atas `index.js`.
- Pakai nomor cadangan untuk bot; bot WA tidak resmi punya risiko nomor kena banned.
