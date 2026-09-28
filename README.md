# Chess 3D Online

Catur 3D (Three.js) dengan 3 mode:

- **Online** — lobby, *Cari Lawan* (matchmaking otomatis per kontrol waktu), buat room publik/private dengan kode & link, chat, tawaran remis, menyerah, jam catur, rematch, lanjut main setelah reload.
- **Lawan Bot** — Easy / Medium / Hard (bot jalan di Web Worker agar layar tidak nge-lag).
- **2 Pemain** di satu layar.

Aturan lengkap: rokade, en passant, promosi (pilih bidak), skak mat, stalemate, remis 50 langkah, posisi berulang 3x, dan bidak tidak cukup.

## Setup Firebase (gratis, paket Spark)

1. Buka [Firebase Console](https://console.firebase.google.com) → project **pos-kasir** → **Build → Realtime Database** → **Create Database** (pilih region, mode *locked* tidak masalah).
2. Salin URL database (tertulis di atas daftar data) ke `databaseURL` di [`firebase-config.js`](firebase-config.js).
   - Region US: `https://pos-kasir-default-rtdb.firebaseio.com`
   - Region Singapura: `https://pos-kasir-default-rtdb.asia-southeast1.firebasedatabase.app`
3. Tab **Rules** — **tambahkan** node `chess` di dalam rules yang sudah ada (jangan hapus rules POS kamu):

```json
{
  "rules": {
    "chess": {
      ".read": true,
      ".write": true,
      "rooms": { ".indexOn": ["status", "created"] }
    }
  }
}
```

Rules ini hanya membuka path `/chess`; data lain di database tetap mengikuti rules lamamu.

## Menjalankan

Web Worker tidak jalan dari `file://`, jadi jalankan lewat server lokal (bot tetap berfungsi tanpa worker, hanya sedikit tersendat saat mode Hard):

```bash
npx serve .        # atau: python -m http.server
```

Lalu buka `http://localhost:3000/chess/`. Untuk tes online, buka di dua browser/tab (atau HP + laptop) lalu tekan **Cari Lawan** di keduanya.

## Struktur data (`/chess`)

- `presence/{uid}` — pemain yang sedang online (dihapus otomatis saat disconnect).
- `rooms/{KODE}` — `status` (`waiting`/`playing`/`finished`), pemain `w`/`b`, `moves` (UCI + sisa waktu), `chat`, `draw`, `result`, `rm` (rematch), `conn`.
- Room lama (> 3 jam) dibersihkan otomatis saat ada yang membuka lobby.
