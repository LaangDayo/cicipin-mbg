CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS sekolah (
  npsn VARCHAR(16) PRIMARY KEY,
  nama_sekolah VARCHAR(150) NOT NULL,
  jenjang VARCHAR(20) NOT NULL,
  is_aktif BOOLEAN DEFAULT TRUE,
  geom GEOMETRY(Polygon, 4326) NOT NULL,
  dibuat_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS distribusi_harian (
  id_distribusi SERIAL PRIMARY KEY,
  npsn VARCHAR(16) REFERENCES sekolah(npsn) ON DELETE CASCADE,
  tanggal_distribusi DATE NOT NULL DEFAULT CURRENT_DATE,
  daftar_menu TEXT NOT NULL,
  kuota_penerima_aktual INTEGER DEFAULT 0,
  diperbarui_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (npsn, tanggal_distribusi)
);

CREATE TABLE IF NOT EXISTS sesi_pelapor (
  token_hash VARCHAR(64) PRIMARY KEY,
  npsn VARCHAR(16) REFERENCES sekolah(npsn) ON DELETE CASCADE,
  tanggal_sesi DATE NOT NULL DEFAULT CURRENT_DATE,
  sudah_mengisi BOOLEAN DEFAULT FALSE,
  dibuat_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS umpan_balik (
  id_umpan_balik SERIAL PRIMARY KEY,
  npsn VARCHAR(16) REFERENCES sekolah(npsn) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  sumber_laporan VARCHAR(20) NOT NULL DEFAULT 'SISWA',
  skor_rasa SMALLINT NOT NULL CHECK (skor_rasa BETWEEN 1 AND 5),
  skor_kesegaran SMALLINT NOT NULL CHECK (skor_kesegaran BETWEEN 1 AND 5),
  skor_porsi SMALLINT NOT NULL CHECK (skor_porsi BETWEEN 1 AND 5),
  skor_ketepatan_waktu SMALLINT NOT NULL CHECK (skor_ketepatan_waktu BETWEEN 1 AND 5),
  kategori_keluhan TEXT[] DEFAULT '{}',
  deskripsi_keluhan TEXT DEFAULT '',
  url_foto_bukti TEXT DEFAULT '',
  akurasi_gps NUMERIC(8, 2) DEFAULT 10,
  lokasi_pengiriman GEOMETRY(Point, 4326),
  catatan_klarifikasi_sekolah TEXT DEFAULT '',
  waktu_lapor TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Akun Multi-Peran (SEKOLAH, BGN, PENGEMBANG)
DROP TABLE IF EXISTS akun_pengguna CASCADE;
CREATE TABLE akun_pengguna (
  id_akun SERIAL PRIMARY KEY,
  nama_lengkap VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  kata_sandi_hash TEXT NOT NULL,
  peran VARCHAR(25) NOT NULL CHECK (peran IN ('SEKOLAH', 'BGN', 'PENGEMBANG')),
  npsn_sekolah VARCHAR(16) REFERENCES sekolah(npsn) ON DELETE SET NULL,
  instansi VARCHAR(150) NOT NULL,
  dibuat_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Data Awal 3 Sekolah di Bandung
INSERT INTO sekolah (npsn, nama_sekolah, jenjang, is_aktif, geom)
VALUES
  (
    '20219303',
    'SDN 032 Tilil Bandung',
    'SD',
    TRUE,
    ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[107.6320,-6.8976],[107.6327,-6.8976],[107.6327,-6.8969],[107.6320,-6.8969],[107.6320,-6.8976]]]}'), 4326)
  ),
  (
    '20219202',
    'SMPN 16 Bandung',
    'SMP',
    TRUE,
    ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[107.6352,-6.8994],[107.6361,-6.8994],[107.6361,-6.8986],[107.6352,-6.8986],[107.6352,-6.8994]]]}'), 4326)
  ),
  (
    '20219101',
    'SMAN 10 Bandung',
    'SMA',
    TRUE,
    ST_SetSRID(ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[[[107.6383,-6.8998],[107.6393,-6.8998],[107.6393,-6.8990],[107.6383,-6.8990],[107.6383,-6.8998]]]}'), 4326)
  )
ON CONFLICT (npsn) DO NOTHING;

INSERT INTO distribusi_harian (npsn, tanggal_distribusi, daftar_menu, kuota_penerima_aktual)
VALUES
  ('20219303', CURRENT_DATE, 'Nasi Putih, Telur Dadar Sayur, Sup Wortel Kentang, Pepaya, Susu UHT', 320),
  ('20219202', CURRENT_DATE, 'Nasi Putih, Ayam Bakar Kecap, Tumis Buncis Jagung, Pisang Ambon, Susu UHT', 540),
  ('20219101', CURRENT_DATE, 'Nasi Putih, Ikan Fillet Saus Asam Manis, Capcay Sayuran, Jeruk Manis, Susu UHT', 680)
ON CONFLICT (npsn, tanggal_distribusi) DO NOTHING;