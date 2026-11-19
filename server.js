require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'cicipin_mbg',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD
      }
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg');
    const unik = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, unik);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }
});

function hashKataSandi(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// 1. Inisialisasi Sesi & Validasi Geofencing PostGIS
app.post('/api/sesi/inisialisasi', async (req, res) => {
  const { npsn, longitude, latitude, token_tersimpan } = req.body;
  if (!npsn || longitude === undefined || latitude === undefined) {
    return res.status(400).json({ message: 'Data sekolah dan koordinat wajib dikirim.' });
  }

  try {
    const qSekolah = await pool.query(
      `SELECT npsn, nama_sekolah, jenjang,
              ST_Within(
                ST_SetSRID(ST_MakePoint($2, $3), 4326),
                geom
              ) AS dalam_zona
       FROM sekolah
       WHERE npsn = $1
       LIMIT 1`,
      [npsn, Number(longitude), Number(latitude)]
    );

    if (qSekolah.rows.length === 0) {
      return res.status(404).json({ message: 'Satuan pendidikan tidak ditemukan.' });
    }

    const infoSekolah = qSekolah.rows[0];

    if (token_tersimpan) {
      const qCekToken = await pool.query(
        `SELECT token_hash, npsn, sudah_mengisi, dalam_zona
         FROM sesi_pelapor
         WHERE token_hash = $1 AND npsn = $2 AND tanggal_sesi = CURRENT_DATE
         LIMIT 1`,
        [token_tersimpan, npsn]
      );

      if (qCekToken.rows.length > 0) {
        return res.json({
          data: {
            token_hash: qCekToken.rows[0].token_hash,
            npsn: infoSekolah.npsn,
            nama_sekolah: infoSekolah.nama_sekolah,
            dalam_zona: qCekToken.rows[0].dalam_zona,
            sudah_mengisi: qCekToken.rows[0].sudah_mengisi
          }
        });
      }
    }

    const tokenBaru = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO sesi_pelapor (
        token_hash, npsn, tanggal_sesi, dalam_zona, sudah_mengisi, lokasi_inisialisasi
      ) VALUES (
        $1, $2, CURRENT_DATE, $3, FALSE, ST_SetSRID(ST_MakePoint($4, $5), 4326)
      )`,
      [
        tokenBaru,
        npsn,
        Boolean(infoSekolah.dalam_zona),
        Number(longitude),
        Number(latitude)
      ]
    );

    return res.json({
      data: {
        token_hash: tokenBaru,
        npsn: infoSekolah.npsn,
        nama_sekolah: infoSekolah.nama_sekolah,
        dalam_zona: Boolean(infoSekolah.dalam_zona),
        sudah_mengisi: false
      }
    });
  } catch (err) {
    console.error('Galat inisialisasi sesi:', err);
    return res.status(500).json({ message: 'Gagal memvalidasi lokasi pada server.' });
  }
});

// 2. Pengiriman Umpan Balik Siswa Mandiri
app.post('/api/umpan-balik', upload.single('foto_bukti'), async (req, res) => {
  const {
    token_hash,
    menu_diterima,
    tanggal_kejadian,
    jam_tiba,
    skor_rasa,
    skor_kesegaran,
    skor_porsi,
    skor_ketepatan_waktu,
    kategori_keluhan,
    deskripsi_keluhan,
    longitude,
    latitude,
    akurasi_gps
  } = req.body;

  if (!token_hash || !req.file) {
    return res.status(400).json({ message: 'Token sesi dan foto bukti makanan wajib diisi.' });
  }

  try {
    const qSesi = await pool.query(
      `SELECT token_hash, npsn, sudah_mengisi
       FROM sesi_pelapor
       WHERE token_hash = $1 AND tanggal_sesi = CURRENT_DATE
       LIMIT 1`,
      [token_hash]
    );

    if (qSesi.rows.length === 0) {
      return res.status(403).json({ message: 'Token sesi tidak valid atau sudah lewat.' });
    }
    if (qSesi.rows[0].sudah_mengisi) {
      return res.status(409).json({ message: 'Sesi ini sudah mengirim laporan hari ini.' });
    }

    const npsn = qSesi.rows[0].npsn;
    let keluhanArray = [];
    if (kategori_keluhan) {
      keluhanArray = Array.isArray(kategori_keluhan)
        ? kategori_keluhan
        : JSON.parse(kategori_keluhan);
    }

    const urlFoto = `/uploads/${req.file.filename}`;

    await pool.query(
      `INSERT INTO umpan_balik (
        npsn, token_hash, sumber_laporan,
        menu_diterima, tanggal_kejadian, jam_tiba,
        skor_rasa, skor_kesegaran, skor_porsi, skor_ketepatan_waktu,
        kategori_keluhan, deskripsi_keluhan, url_foto_bukti,
        akurasi_gps, lokasi_pengiriman
      ) VALUES (
        $1, $2, 'SISWA',
        $3, COALESCE($4::date, CURRENT_DATE), NULLIF($5, '')::time,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, ST_SetSRID(ST_MakePoint($14, $15), 4326)
      )`,
      [
        npsn,
        token_hash,
        (menu_diterima || '').trim(),
        tanggal_kejadian || null,
        jam_tiba || '',
        Number(skor_rasa),
        Number(skor_kesegaran),
        Number(skor_porsi),
        Number(skor_ketepatan_waktu),
        keluhanArray,
        deskripsi_keluhan || '',
        urlFoto,
        Number(akurasi_gps) || 10,
        Number(longitude),
        Number(latitude)
      ]
    );

    await pool.query(
      `UPDATE sesi_pelapor SET sudah_mengisi = TRUE WHERE token_hash = $1`,
      [token_hash]
    );

    return res.status(201).json({ message: 'Umpan balik berhasil disimpan.' });
  } catch (err) {
    console.error('Galat simpan umpan balik:', err);
    return res.status(500).json({ message: 'Gagal menyimpan umpan balik ke database.' });
  }
});

// 3. Mode Kios Kelas SD (Opsional untuk Guru SD)
app.post('/api/kios/mulai', upload.single('foto_bukti'), async (req, res) => {
  const { token_hash } = req.body;
  if (!token_hash || !req.file) {
    return res.status(400).json({ message: 'Token sesi dan foto bukti kelas wajib diisi.' });
  }
  return res.json({
    message: 'Sesi kios aktif.',
    url_foto_bukti: `/uploads/${req.file.filename}`
  });
});

app.post('/api/kios/vote', async (req, res) => {
  const {
    master_token,
    nama_kelas,
    menu_diterima,
    tanggal_kejadian,
    jam_tiba,
    skor_pilihan,
    kategori_keluhan,
    url_foto_bukti,
    longitude,
    latitude,
    akurasi_gps
  } = req.body;

  try {
    const qSesi = await pool.query(
      `SELECT npsn FROM sesi_pelapor WHERE token_hash = $1 LIMIT 1`,
      [master_token]
    );
    if (qSesi.rows.length === 0) {
      return res.status(403).json({ message: 'Token sesi kios tidak valid.' });
    }

    const npsn = qSesi.rows[0].npsn;
    const skor = Number(skor_pilihan);
    const keluhanArr = Array.isArray(kategori_keluhan) ? kategori_keluhan : [];

    await pool.query(
      `INSERT INTO umpan_balik (
        npsn, token_hash, sumber_laporan,
        menu_diterima, tanggal_kejadian, jam_tiba,
        skor_rasa, skor_kesegaran, skor_porsi, skor_ketepatan_waktu,
        kategori_keluhan, deskripsi_keluhan, url_foto_bukti,
        akurasi_gps, lokasi_pengiriman
      ) VALUES (
        $1, $2, 'KIOS_SD',
        $3, COALESCE($4::date, CURRENT_DATE), NULLIF($5, '')::time,
        $6, $6, $6, $6,
        $7, $8, $9,
        $10, ST_SetSRID(ST_MakePoint($11, $12), 4326)
      )`,
      [
        npsn,
        master_token,
        (menu_diterima || '').trim(),
        tanggal_kejadian || null,
        jam_tiba || '',
        skor,
        keluhanArr,
        `Voting Kios (${nama_kelas || 'Kelas SD'})`,
        url_foto_bukti || '',
        Number(akurasi_gps) || 8,
        Number(longitude),
        Number(latitude)
      ]
    );

    return res.status(201).json({ message: 'Suara siswa tercatat.' });
  } catch (err) {
    console.error('Galat simpan vote kios:', err);
    return res.status(500).json({ message: 'Gagal mencatat suara siswa.' });
  }
});

// 4. Data Spasial Publik (Peta Sebaran & Peta Tematik)
app.get('/api/publik/peta', async (_req, res) => {
  try {
    const qSekolah = await pool.query(
      `SELECT npsn, nama_sekolah, jenjang, ST_AsGeoJSON(geom)::json AS geometry
       FROM sekolah
       ORDER BY nama_sekolah ASC`
    );

    const qAgregat = await pool.query(
      `SELECT
         s.npsn,
         s.nama_sekolah,
         s.jenjang,
         COUNT(u.id_umpan_balik)::int AS total_laporan,
         ROUND(AVG((u.skor_rasa + u.skor_kesegaran + u.skor_porsi + u.skor_ketepatan_waktu) / 4.0), 2) AS indeks_mutu,
         ROUND(AVG(u.skor_rasa), 2) AS rata_rasa,
         ROUND(AVG(u.skor_kesegaran), 2) AS rata_segar,
         ROUND(AVG(u.skor_porsi), 2) AS rata_porsi,
         ROUND(AVG(u.skor_ketepatan_waktu), 2) AS rata_waktu,
         ROUND(
           100.0 * COUNT(CASE WHEN cardinality(u.kategori_keluhan) > 0 THEN 1 END)
           / NULLIF(COUNT(u.id_umpan_balik), 0),
           1
         ) AS persen_keluhan
       FROM sekolah s
       LEFT JOIN umpan_balik u ON s.npsn = u.npsn
       GROUP BY s.npsn, s.nama_sekolah, s.jenjang
       ORDER BY s.nama_sekolah ASC`
    );

    return res.json({
      sekolah: qSekolah.rows,
      agregat: qAgregat.rows
    });
  } catch (err) {
    console.error('Galat muat data peta:', err);
    return res.status(500).json({ message: 'Gagal memuat data spasial.' });
  }
});

// 5. Endpoint Unduh Dataset (CSV & GeoJSON - Koordinat Sekolah Saja untuk Privasi Siswa)
async function ambilDatasetLaporan(_req, res) {
  try {
    const qLaporan = await pool.query(
      `SELECT u.id_umpan_balik, u.npsn, s.nama_sekolah, s.jenjang,
              u.sumber_laporan,
              u.menu_diterima,
              TO_CHAR(COALESCE(u.tanggal_kejadian, u.waktu_lapor::date), 'YYYY-MM-DD') AS tanggal_distribusi,
              TO_CHAR(u.jam_tiba, 'HH24:MI') AS jam_tiba,
              u.skor_rasa, u.skor_kesegaran, u.skor_porsi, u.skor_ketepatan_waktu,
              u.kategori_keluhan, u.deskripsi_keluhan, u.url_foto_bukti,
              ROUND(ST_Y(ST_Centroid(s.geom))::numeric, 6) AS lintang_sekolah,
              ROUND(ST_X(ST_Centroid(s.geom))::numeric, 6) AS bujur_sekolah,
              u.waktu_lapor
       FROM umpan_balik u
       JOIN sekolah s ON u.npsn = s.npsn
       ORDER BY u.waktu_lapor DESC`
    );

    return res.json({ laporan: qLaporan.rows });
  } catch (err) {
    console.error('Galat unduh dataset:', err);
    return res.status(500).json({ message: 'Gagal mengambil dataset laporan.' });
  }
}

app.get('/api/dataset/unduh', ambilDatasetLaporan);
app.get('/api/bgn/evaluasi', ambilDatasetLaporan);

// 6. Manajemen Poligon Geofencing PostGIS (Khusus Pengembang)
app.get('/api/admin/ringkasan', async (_req, res) => {
  try {
    const qSekolah = await pool.query(
      `SELECT npsn, nama_sekolah, jenjang, ST_AsGeoJSON(geom)::json AS geometry
       FROM sekolah
       ORDER BY nama_sekolah ASC`
    );
    const qTitik = await pool.query(
      `SELECT u.id_umpan_balik, s.nama_sekolah,
              ST_Y(u.lokasi_pengiriman) AS lat,
              ST_X(u.lokasi_pengiriman) AS lng,
              u.waktu_lapor
       FROM umpan_balik u
       JOIN sekolah s ON u.npsn = s.npsn
       ORDER BY u.waktu_lapor DESC
       LIMIT 100`
    );
    return res.json({ sekolah: qSekolah.rows, titik: qTitik.rows });
  } catch (err) {
    console.error('Galat ringkasan admin:', err);
    return res.status(500).json({ message: 'Gagal memuat data manajemen poligon.' });
  }
});

app.post('/api/admin/sekolah', async (req, res) => {
  const { npsn, nama_sekolah, jenjang, geometry } = req.body;
  if (!npsn || !nama_sekolah || !jenjang || !geometry) {
    return res.status(400).json({ message: 'NPSN, nama sekolah, jenjang, dan poligon GeoJSON wajib diisi.' });
  }

  try {
    const geoStr = typeof geometry === 'string' ? geometry : JSON.stringify(geometry);
    await pool.query(
      `INSERT INTO sekolah (npsn, nama_sekolah, jenjang, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
       ON CONFLICT (npsn) DO UPDATE
       SET nama_sekolah = EXCLUDED.nama_sekolah,
           jenjang = EXCLUDED.jenjang,
           geom = EXCLUDED.geom`,
      [npsn.trim(), nama_sekolah.trim(), jenjang, geoStr]
    );
    return res.status(201).json({ message: 'Poligon sekolah berhasil disimpan ke PostGIS.' });
  } catch (err) {
    console.error('Galat simpan poligon:', err);
    return res.status(500).json({ message: 'Gagal menyimpan geometri poligon.' });
  }
});

// 7. Autentikasi Akun (PENGGUNA & PENGEMBANG)
app.post('/api/auth/register', async (req, res) => {
  const { nama_lengkap, email, password, peran, instansi, kode_pengembang } = req.body;
  if (!nama_lengkap || !email || !password) {
    return res.status(400).json({ message: 'Nama lengkap, email, dan kata sandi wajib diisi.' });
  }

  const peranDipilih = peran || 'PENGGUNA';
  const peranValid = ['PENGGUNA', 'PENGEMBANG'];
  if (!peranValid.includes(peranDipilih)) {
    return res.status(400).json({ message: 'Pilihan peran tidak valid.' });
  }

  if (peranDipilih === 'PENGEMBANG') {
    const kunciTim = process.env.DEV_SECRET_KEY || 'CICIPIN_KEL13_2026';
    if (!kode_pengembang || kode_pengembang !== kunciTim) {
      return res.status(403).json({
        message: 'Akses ditolak. Pendaftaran akun Pengembang khusus anggota tim internal yang memiliki Kode Otorisasi.'
      });
    }
  }

  try {
    const hash = hashKataSandi(password);
    const qInsert = await pool.query(
      `INSERT INTO akun_pengguna (nama_lengkap, email, kata_sandi_hash, peran, instansi)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id_akun, nama_lengkap, email, peran, instansi`,
      [
        nama_lengkap.trim(),
        email.trim().toLowerCase(),
        hash,
        peranDipilih,
        (instansi || 'Umum').trim()
      ]
    );

    return res.status(201).json({
      message: 'Registrasi akun berhasil.',
      user: qInsert.rows[0]
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Email tersebut sudah terdaftar.' });
    }
    console.error('Galat registrasi:', err);
    return res.status(500).json({ message: 'Gagal mendaftarkan akun baru.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email dan kata sandi wajib diisi.' });
  }

  try {
    const qUser = await pool.query(
      `SELECT id_akun, nama_lengkap, email, kata_sandi_hash, peran, instansi
       FROM akun_pengguna
       WHERE email = $1
       LIMIT 1`,
      [email.trim().toLowerCase()]
    );

    if (qUser.rows.length === 0) {
      return res.status(401).json({ message: 'Email belum terdaftar.' });
    }

    const user = qUser.rows[0];
    if (user.kata_sandi_hash !== hashKataSandi(password)) {
      return res.status(401).json({ message: 'Kata sandi tidak sesuai.' });
    }

    return res.json({
      message: 'Berhasil masuk.',
      user: {
        id_akun: user.id_akun,
        nama_lengkap: user.nama_lengkap,
        email: user.email,
        peran: user.peran,
        instansi: user.instansi
      }
    });
  } catch (err) {
    console.error('Galat login:', err);
    return res.status(500).json({ message: 'Gagal memproses autentikasi.' });
  }
});

// 8. Rute Halaman HTML
app.get('/masuk', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'masuk.html'));
});

app.get('/kios', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kios.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server Cicipin MBG berjalan aktif di http://localhost:${PORT}`);
});