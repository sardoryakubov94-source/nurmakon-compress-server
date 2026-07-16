/* ============================================================
   NurMakon — Serverda video siqish (Render.com uchun)
   ------------------------------------------------------------
   Bu fayl avvalgi Firebase Cloud Function (index.js) bilan BIR
   XIL ishlaydi (ffmpeg + Supabase Storage), lekin Firebase o'rniga
   Render.com kabi istalgan oddiy Node hostingda ishlaydi.

   Sozlash tartibi pastdagi "DEPLOY QO'LLANMASI" bo'limida yozilgan.
   ============================================================ */

const express = require('express');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
const Busboy = require('busboy');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

/* ---- Sozlamalar ---- */
const SUPABASE_URL = 'https://ppxrkqiekfriwwwexgiz.supabase.co';
const SUPABASE_BUCKET = 'Videos';

// MUHIM: bu kalitni hech qachon kodga yozib qo'ymang.
// Render dashboard -> Environment -> Environment Variables ichida
// SUPABASE_SERVICE_KEY nomi bilan qo'shiladi (pastda ko'rsatilgan).
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MAX_UPLOAD_MB = 120;
const MAX_DIM = 640;
const TARGET_VIDEO_BITRATE = '900k';
const TARGET_AUDIO_BITRATE = '96k';
const PORT = process.env.PORT || 3000;

const app = express();

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// ---- Keep-alive uchun oddiy health-check (cron-job.org shu manzilga ping qiladi) ----
app.get('/health', (req, res) => {
  setCors(res);
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

app.options('/compressVideo', (req, res) => {
  setCors(res);
  res.status(204).send('');
});

app.post('/compressVideo', (req, res) => {
  setCors(res);

  if (!SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: 'SUPABASE_SERVICE_KEY sozlanmagan (Render Environment Variables)' });
    return;
  }

  const tmpId = crypto.randomUUID();
  const inputPath = path.join(os.tmpdir(), `in_${tmpId}`);
  const outputPath = path.join(os.tmpdir(), `out_${tmpId}.mp4`);

  let gotFile = false;
  let tooBig = false;
  let writeStream = null;
  let writeDone = null;

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
  });

  busboy.on('file', (_name, stream) => {
    gotFile = true;
    writeStream = fs.createWriteStream(inputPath);
    writeDone = new Promise((resolve) => writeStream.on('close', resolve));
    stream.on('limit', () => { tooBig = true; stream.unpipe(writeStream); writeStream.end(); });
    stream.pipe(writeStream);
  });

  busboy.on('finish', async () => {
    try {
      if (!gotFile) { res.status(400).json({ error: 'Video fayl topilmadi' }); return; }
      await writeDone;
      if (tooBig) { throw new Error(`Video ${MAX_UPLOAD_MB}MB dan katta bo'lmasligi kerak`); }

      // ---- ffmpeg bilan siqish ----
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .videoFilters(`scale='min(${MAX_DIM},iw)':'min(${MAX_DIM},ih)':force_original_aspect_ratio=decrease`)
          .videoBitrate(TARGET_VIDEO_BITRATE)
          .audioBitrate(TARGET_AUDIO_BITRATE)
          .outputOptions(['-preset veryfast', '-movflags +faststart', '-c:v libx264', '-c:a aac', '-pix_fmt yuv420p'])
          .on('error', reject)
          .on('end', resolve)
          .save(outputPath);
      });

      // ---- Supabase Storage'ga yuklash ----
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const fileBuffer = fs.readFileSync(outputPath);
      const objectPath = `${crypto.randomUUID()}.mp4`;
      const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(objectPath, fileBuffer, {
        contentType: 'video/mp4', upsert: false, cacheControl: '3600'
      });
      if (error) throw error;
      const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(objectPath);
      res.status(200).json({ url: data.publicUrl });
    } catch (err) {
      console.error('compressVideo xatosi:', err);
      res.status(500).json({ error: (err && err.message) || 'Videoni qayta ishlashda xatolik' });
    } finally {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    }
  });

  req.pipe(busboy);
});

app.listen(PORT, () => {
  console.log(`NurMakon compress server ${PORT}-portda ishga tushdi`);
});

/* ============================================================
   DEPLOY QO'LLANMASI (Render.com, tekin)
   ------------------------------------------------------------
   1) Ushbu papkani (package.json + index.js) GitHub'ga alohida
      repo sifatida yuklang (masalan: nurmakon-compress-server).

   2) https://render.com -> ro'yxatdan o'ting (GitHub bilan kirish
      qulay) -> "New +" -> "Web Service" -> shu repo'ni tanlang.

   3) Sozlamalar:
      - Name: nurmakon-compress (yoki xohlagan nom)
      - Region: xohlagan (Frankfurt yaqinroq bo'ladi)
      - Branch: main
      - Runtime: Node
      - Build Command: npm install
      - Start Command: npm start
      - Instance Type: Free

   4) "Environment" bo'limida quyidagini qo'shing:
      Key:   SUPABASE_SERVICE_KEY
      Value: (avvalgi Firebase Secret'dagi service_role kalit)

   5) "Create Web Service" -> bir necha daqiqada deploy bo'ladi.
      Sizga shunday manzil beriladi:
      https://nurmakon-compress.onrender.com

   6) index-8-2.html faylida VIDEO_COMPRESS_FUNCTION_URL ni
      shunga almashtiring:
      https://nurmakon-compress.onrender.com/compressVideo

   7) UXLAB QOLMASLIGI UCHUN (keep-alive, tekin):
      - https://cron-job.org ga tekin ro'yxatdan o'ting
      - "Create cronjob" -> URL:
        https://nurmakon-compress.onrender.com/health
      - Interval: har 10 daqiqada
      - Saqlang. Shu bilan server hech qachon uxlamaydi.
   ============================================================ */
