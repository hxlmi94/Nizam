import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------------------
// Gerekli ortam değişkenlerini kontrol et (eksikse net bir hata ver)
// ------------------------------------------------------------------
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_PASSWORD'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('EKSİK ORTAM DEĞİŞKENLERİ:', missing.join(', '));
  console.error('Render → Environment sekmesinden bu değerleri eklemeniz gerekiyor.');
}

// Neon/Supabase/Render gibi barındırılan Postgres servisleri SSL ister;
// yerel geliştirme/test veritabanı (localhost) SSL istemez.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});
async function q(text, params) {
  return pool.query(text, params);
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const CHAT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ------------------------------------------------------------------
// Basit tek-kullanıcılı giriş (tek yönetici için)
// ------------------------------------------------------------------
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Giriş kodu gerekli' });
  const okPass = safeEqual(String(password), String(process.env.ADMIN_PASSWORD));
  if (!okPass) return res.status(401).json({ error: 'Giriş kodu hatalı' });
  const token = jwt.sign({ sub: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ------------------------------------------------------------------
// İşletmeler (Zeytinkule / ofisler / inşaatlar) — her şey buna bağlı
// ------------------------------------------------------------------
app.get('/api/isletmeler', requireAuth, async (req, res) => {
  try {
    const { rows } = await q('select * from isletmeler order by id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/isletmeler', requireAuth, async (req, res) => {
  try {
    const { ad, tip } = req.body || {};
    if (!ad || !['site', 'genel'].includes(tip)) return res.status(400).json({ error: 'ad ve geçerli bir tip (site/genel) gerekli' });
    const { rows } = await q('insert into isletmeler (ad, tip) values ($1, $2) returning *', [ad, tip]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Tüm veriyi tek seferde getir (bir işletmenin verisi — dashboard için)
// ------------------------------------------------------------------
app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const isletmeId = Number(req.query.isletme_id);
    if (!isletmeId) return res.status(400).json({ error: 'isletme_id gerekli' });
    const [a, p, e, s, mi, g] = await Promise.all([
      q('select * from apartments where isletme_id = $1 order by no', [isletmeId]),
      q('select * from payments where isletme_id = $1', [isletmeId]),
      q('select * from expenses where isletme_id = $1 order by id desc', [isletmeId]),
      q('select * from staff where isletme_id = $1 order by id', [isletmeId]),
      q('select * from maintenance_items where isletme_id = $1 order by id', [isletmeId]),
      q('select * from gelirler where isletme_id = $1 order by id desc', [isletmeId]),
    ]);
    // staff_payments'in kendi isletme_id'si yok (staff_id üzerinden bağlı) — bu işletmenin
    // personel id'lerine göre ayrıca filtrele.
    const staffIds = s.rows.map((row) => row.id);
    let staffPayments = [];
    if (staffIds.length) {
      const { rows } = await q('select * from staff_payments where staff_id = any($1::bigint[])', [staffIds]);
      staffPayments = rows;
    }
    res.json({
      apartments: a.rows,
      payments: p.rows,
      expenses: e.rows,
      staff: s.rows,
      staffPayments,
      maintenanceItems: mi.rows,
      gelirler: g.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Daireler — durum / kiracı adı güncelleme (cari hesap alanları)
// ------------------------------------------------------------------
app.put('/api/apartments/:no', requireAuth, async (req, res) => {
  try {
    const isletmeId = Number(req.query.isletme_id);
    if (!isletmeId) return res.status(400).json({ error: 'isletme_id gerekli' });
    const { durum, kiraci_adi } = req.body || {};
    const { rows } = await q(
      `update apartments set
         durum = coalesce($3, durum),
         kiraci_adi = $4
       where isletme_id = $1 and no = $2
       returning *`,
      [isletmeId, req.params.no, durum ?? null, kiraci_adi ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Ödemeler (aidat / demirbaş) — sadece 'site' tipi işletmelerde
// ------------------------------------------------------------------
app.post('/api/payments/upsert', requireAuth, async (req, res) => {
  try {
    const { isletme_id, apartment_no, tur, donem, durum, tutar_odenen, not_metni } = req.body || {};
    if (!isletme_id || !apartment_no || !tur || !donem) return res.status(400).json({ error: 'isletme_id, apartment_no, tur, donem gerekli' });
    const { rows } = await q(
      `insert into payments (isletme_id, apartment_no, tur, donem, durum, tutar_odenen, not_metni, kaynak, guncelleme_tarihi)
       values ($1, $2, $3, $4, $5, $6, $7, 'Uygulama', now())
       on conflict (isletme_id, apartment_no, tur, donem) do update set
         durum = excluded.durum,
         tutar_odenen = excluded.tutar_odenen,
         not_metni = excluded.not_metni,
         kaynak = excluded.kaynak,
         guncelleme_tarihi = excluded.guncelleme_tarihi
       returning *`,
      [isletme_id, apartment_no, tur, donem, durum || 'ÖDENMEDİ', tutar_odenen ?? null, not_metni ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Yeni ay: tüm dairelere o ay için ödenmedi satırı aç
app.post('/api/months', requireAuth, async (req, res) => {
  try {
    const { isletme_id, donem } = req.body || {};
    if (!isletme_id || !donem) return res.status(400).json({ error: 'isletme_id, donem gerekli' });
    const { rows: apts } = await q('select no from apartments where isletme_id = $1', [isletme_id]);
    if (!apts.length) return res.json([]);
    const values = [];
    const params = [];
    apts.forEach((a, i) => {
      const base = i * 2;
      values.push(`($1, $${base + 2}, 'aidat', $${base + 3}, 'ÖDENMEDİ', 'Uygulama')`);
      params.push(a.no, donem);
    });
    const { rows } = await q(
      `insert into payments (isletme_id, apartment_no, tur, donem, durum, kaynak)
       values ${values.join(', ')}
       returning *`,
      [isletme_id, ...params]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Gelirler (ofis / inşaat gibi 'genel' tipi işletmelerde — serbest açıklamalı gelir kaydı)
// ------------------------------------------------------------------
app.post('/api/gelirler', requireAuth, async (req, res) => {
  try {
    const { isletme_id, aciklama, tutar, tarih, durum, not_metni } = req.body || {};
    const { rows } = await q(
      `insert into gelirler (isletme_id, aciklama, tutar, tarih, durum, not_metni)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [isletme_id, aciklama ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/gelirler/:id', requireAuth, async (req, res) => {
  try {
    const { aciklama, tutar, tarih, durum, not_metni } = req.body || {};
    const { rows } = await q(
      `update gelirler set aciklama = $2, tutar = $3, tarih = $4, durum = $5, not_metni = $6
       where id = $1 returning *`,
      [req.params.id, aciklama ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/gelirler/:id', requireAuth, async (req, res) => {
  try {
    await q('delete from gelirler where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Giderler
// ------------------------------------------------------------------
// Bir gider kaydı "ÖDENDİ" olarak bir bakım kalemine bağlıysa,
// o bakımın "en son ne zaman yapıldığı" bilgisini günceller.
async function syncMaintenanceFromExpense(expense) {
  if (!expense || !expense.bakim_id || expense.durum !== 'ÖDENDİ') return;
  const tarih = expense.tarih || new Date().toISOString().slice(0, 10);
  await q('update maintenance_items set son_yapilma_tarihi = $2 where id = $1', [expense.bakim_id, tarih]);
}

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { isletme_id, ay, gider_turu, firma, tutar, tarih, durum, not_metni, bakim_id } = req.body || {};
    const { rows } = await q(
      `insert into expenses (isletme_id, ay, gider_turu, firma, tutar, tarih, durum, not_metni, bakim_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [isletme_id, ay ?? null, gider_turu ?? null, firma ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null, bakim_id ?? null]
    );
    await syncMaintenanceFromExpense(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    const { ay, gider_turu, firma, tutar, tarih, durum, not_metni, bakim_id } = req.body || {};
    const { rows } = await q(
      `update expenses set ay = $2, gider_turu = $3, firma = $4, tutar = $5, tarih = $6, durum = $7, not_metni = $8, bakim_id = $9
       where id = $1 returning *`,
      [req.params.id, ay ?? null, gider_turu ?? null, firma ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null, bakim_id ?? null]
    );
    await syncMaintenanceFromExpense(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  try {
    await q('delete from expenses where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Personel
// ------------------------------------------------------------------
app.post('/api/staff', requireAuth, async (req, res) => {
  try {
    const { isletme_id, isim, gorev, aylik_ucret } = req.body || {};
    const { rows } = await q(
      `insert into staff (isletme_id, isim, gorev, aylik_ucret) values ($1, $2, $3, $4) returning *`,
      [isletme_id, isim ?? null, gorev ?? null, aylik_ucret ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const { isim, gorev, aylik_ucret } = req.body || {};
    const { rows } = await q(
      `update staff set isim = $2, gorev = $3, aylik_ucret = $4 where id = $1 returning *`,
      [req.params.id, isim ?? null, gorev ?? null, aylik_ucret ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/staff-payments/upsert', requireAuth, async (req, res) => {
  try {
    const { staff_id, ay, durum, tarih } = req.body || {};
    if (!staff_id || !ay) return res.status(400).json({ error: 'staff_id, ay gerekli' });
    const { rows } = await q(
      `insert into staff_payments (staff_id, ay, durum, tarih)
       values ($1, $2, $3, $4)
       on conflict (staff_id, ay) do update set durum = excluded.durum, tarih = excluded.tarih
       returning *`,
      [staff_id, ay, durum || 'ÖDENMEDİ', tarih || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Bakım kalemleri (asansör, yangın tüpü, jeneratör vb. düzenli bakımlar)
// ------------------------------------------------------------------
app.post('/api/maintenance', requireAuth, async (req, res) => {
  try {
    const { isletme_id, ad, siklik } = req.body || {};
    if (!isletme_id || !ad || !siklik) return res.status(400).json({ error: 'isletme_id, ad, siklik gerekli' });
    const { rows } = await q(
      `insert into maintenance_items (isletme_id, ad, siklik) values ($1, $2, $3) returning *`,
      [isletme_id, ad, siklik]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/maintenance/:id', requireAuth, async (req, res) => {
  try {
    const { ad, siklik, son_yapilma_tarihi } = req.body || {};
    const { rows } = await q(
      `update maintenance_items set
         ad = coalesce($2, ad),
         siklik = coalesce($3, siklik),
         son_yapilma_tarihi = coalesce($4, son_yapilma_tarihi)
       where id = $1 returning *`,
      [req.params.id, ad ?? null, siklik ?? null, son_yapilma_tarihi ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/maintenance/:id', requireAuth, async (req, res) => {
  try {
    await q('delete from maintenance_items where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Ayarlar (yasal belgeler checklist, genel kurul notu gibi küçük anahtar-değer verileri) — işletme bazlı
// ------------------------------------------------------------------
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const isletmeId = Number(req.query.isletme_id);
    if (!isletmeId) return res.status(400).json({ error: 'isletme_id gerekli' });
    const { rows } = await q('select key, value from settings where isletme_id = $1', [isletmeId]);
    const obj = {};
    rows.forEach((r) => { obj[r.key] = r.value; });
    res.json(obj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/:key', requireAuth, async (req, res) => {
  try {
    const { value, isletme_id } = req.body || {};
    if (!isletme_id) return res.status(400).json({ error: 'isletme_id gerekli' });
    const { rows } = await q(
      `insert into settings (isletme_id, key, value, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict (isletme_id, key) do update set value = excluded.value, updated_at = excluded.updated_at
       returning *`,
      [isletme_id, req.params.key, JSON.stringify(value ?? null)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Sohbet asistanı (Claude)
// ------------------------------------------------------------------
app.post('/api/chat', requireAuth, async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanımlı değil' });
  try {
    const { message, history, isletme_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message gerekli' });
    if (!isletme_id) return res.status(400).json({ error: 'isletme_id gerekli' });

    const { rows: isletmeRows } = await q('select * from isletmeler where id = $1', [isletme_id]);
    const isletme = isletmeRows[0];
    const isletmeAdi = isletme?.ad || 'işletme';
    const isSite = isletme?.tip === 'site';

    let context = '';
    let system = '';

    if (isSite) {
      // Güncel duruma dair kısa bir özet çıkar, asistanın gerçek verilerden haberi olsun
      const [{ rows: apartments }, { rows: payments }, { rows: expenses }] = await Promise.all([
        q('select no from apartments where isletme_id = $1', [isletme_id]),
        q('select * from payments where isletme_id = $1', [isletme_id]),
        q('select * from expenses where isletme_id = $1', [isletme_id]),
      ]);
      const months = [...new Set((payments || []).filter((p) => p.tur === 'aidat').map((p) => p.donem))].sort();
      const lastMonth = months[months.length - 1];
      const lastMonthRows = (payments || []).filter((p) => p.tur === 'aidat' && p.donem === lastMonth);
      const odenmeyen = lastMonthRows.filter((p) => p.durum === 'ÖDENMEDİ').length;
      const tahsil = lastMonthRows.reduce((s, p) => s + (Number(p.tutar_odenen) || 0), 0);
      const flagged = (payments || []).filter((p) => ['KONTROL EDİLSİN', 'VERMİYOR'].includes(p.durum));
      const giderToplam = (expenses || []).filter((e) => e.durum === 'ÖDENDİ').reduce((s, e) => s + (Number(e.tutar) || 0), 0);

      context = `
Toplam daire sayısı: ${apartments?.length || 0}
Son işlenen aidat ayı: ${lastMonth || 'yok'}
Bu ayki tahsilat: ${tahsil.toLocaleString('tr-TR')} ₺
Bu ay ödemeyen daire sayısı: ${odenmeyen}
Dikkat gereken kayıt sayısı (kontrol/vermiyor): ${flagged.length}
Toplam ödenen gider (tüm zamanlar): ${giderToplam.toLocaleString('tr-TR')} ₺
`.trim();

      system = `Sen "${isletmeAdi}" sitesinin yönetim asistanısın. Yıllarca site/apartman yönetimi muhasebesi yapmış, Kat Mülkiyeti Kanunu'na hakim, deneyimli bir mali müşavir gibi davran: net, pratik ve güven verici konuş.

Bilmen gereken temel mevzuat noktaları (genel bilgi olarak kullan):
- Karar Defteri: Kat malikleri kurulu kararlarının yazıldığı, noter onaylı, sayfaları numaralı defter. Her yıl 31 Aralık'a kadar noterde kapanış tasdiki yapılması gerekir (KMK md. 32).
- Gelir-Gider Defteri: Tüm aidat tahsilatı ve giderlerin işlendiği, noter onaylı defter; fatura/makbuzlar saklanmalı.
- İşletme Projesi: Yıllık tahmini gelir-gider ve her dairenin payını gösteren, kat maliklerine tebliğ edilmesi gereken belge (KMK md. 37). İtirazlar 7 gün içinde yapılabilir.
- Yedek akçe genellikle yıllık gider toplamının %10'unu geçmeyecek şekilde belirlenir.
- Ortak giderler iki şekilde paylaştırılır: kapıcı/güvenlik gibi hizmetler eşit, diğer giderler (elektrik, bakım vb.) arsa payı/alan oranında.

Yöneticiye aidat, demirbaş, fatura/gider, personel takibi ve site muhasebesiyle ilgili sorularda yardımcı ol. Uygulamanın Özet sekmesindeki "Raporlar ve Belgeler" bölümünde Gelir-Gider Tablosu, İşletme Projesi Hesaplayıcı, Genel Kurul Özet Raporu ve Yasal Belgeler takip listesi olduğunu biliyorsun; ilgili sorularda oraya yönlendirebilirsin.

Her zaman Türkçe, kısa ve net cevaplar ver. Kesin hukuki veya vergisel sonucu olan konularda (ceza, dava süreci, vergi mükellefiyeti gibi) genel bilgi verebilirsin ama bunun bağlayıcı hukuki/mali tavsiye olmadığını, kesinleşmesi gereken konularda bir mali müşavir veya avukata danışılmasını belirt. Aşağıda uygulamanın güncel veri özeti var, sorular buna göre yanıtlanabilir; ama tam liste/detay gerekiyorsa yöneticiye uygulama içindeki ilgili sekmeye bakmasını söyle (elinde satır satır veri yok, sadece bu özet var).\n\nGÜNCEL DURUM:\n${context}`;
    } else {
      const [{ rows: gelirler }, { rows: expenses }] = await Promise.all([
        q('select * from gelirler where isletme_id = $1', [isletme_id]),
        q('select * from expenses where isletme_id = $1', [isletme_id]),
      ]);
      const gelirToplam = (gelirler || []).filter((g) => g.durum === 'ÖDENDİ').reduce((s, g) => s + (Number(g.tutar) || 0), 0);
      const giderToplam = (expenses || []).filter((e) => e.durum === 'ÖDENDİ').reduce((s, e) => s + (Number(e.tutar) || 0), 0);

      context = `
Toplam gelen para (ödendi işaretli): ${gelirToplam.toLocaleString('tr-TR')} ₺
Toplam ödenen gider: ${giderToplam.toLocaleString('tr-TR')} ₺
Net durum: ${(gelirToplam - giderToplam).toLocaleString('tr-TR')} ₺
`.trim();

      system = `Sen "${isletmeAdi}" işletmesinin (ofis veya inşaat projesi olabilir) muhasebe asistanısın. Deneyimli bir mali müşavir gibi net, pratik ve güven verici konuş. Gelir ve gider kayıtları, personel maaş takibi hakkında sorulara yardımcı ol. Kesin hukuki/vergisel konularda genel bilgi verip bir mali müşavir/avukata danışılmasını öner. Türkçe, kısa ve net cevaplar ver.\n\nGÜNCEL DURUM:\n${context}`;
    }

    const msg = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system,
      messages: [...(Array.isArray(history) ? history : []), { role: 'user', content: message }],
    });
    const text = msg.content.find((b) => b.type === 'text')?.text || '';
    res.json({ response: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — bilinmeyen GET istekleri index.html'e düşsün
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nizam sunucusu ${PORT} portunda çalışıyor`));
