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

// node-postgres, hassasiyet kaybı olmasın diye bigint (id sütunları) ve
// numeric (tutar sütunları) değerlerini varsayılan olarak METİN (string) döner
// — Supabase'in eski davranışıyla (bunları sayı olarak dönüyordu) birebir
// aynı olsun ve arayüzdeki id/id karşılaştırmaları ve tutar hesapları
// bozulmasın diye burada sayıya çeviriyoruz.
pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10))); // int8 / bigint
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); // numeric
// 'date' sütunlarını (tarih, baslangic_tarihi, tarih vb.) node-postgres'in varsayılanı olan
// JS Date nesnesine çevirmeden, Postgres'ten geldiği gibi 'YYYY-MM-DD' metni olarak bırak.
// Aksi halde JSON'a çevrilirken saat eklenir (ör. "2026-08-20T00:00:00.000Z") ve arayüzdeki
// <input type="date"> alanları bunu tanımadığı için kayıt düzenlemede tarih boş görünür.
pg.types.setTypeParser(1082, (val) => val); // date

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
app.use(express.json({ limit: '12mb' }));
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
    const [a, p, e, s, mi, g, c, pr] = await Promise.all([
      q('select * from apartments where isletme_id = $1 order by no', [isletmeId]),
      q('select * from payments where isletme_id = $1', [isletmeId]),
      q(`select ${EXPENSE_RETURNING} from expenses where isletme_id = $1 order by id desc`, [isletmeId]),
      q(`select ${STAFF_RETURNING} from staff where isletme_id = $1 order by id`, [isletmeId]),
      q('select * from maintenance_items where isletme_id = $1 order by id', [isletmeId]),
      q('select * from gelirler where isletme_id = $1 order by id desc', [isletmeId]),
      q(`select ${CONTRACT_RETURNING} from contracts where isletme_id = $1 order by id desc`, [isletmeId]),
      q('select * from projeler where isletme_id = $1 order by id desc', [isletmeId]),
    ]);
    // staff_payments'in kendi isletme_id'si yok (staff_id üzerinden bağlı) — bu işletmenin
    // personel id'lerine göre ayrıca filtrele.
    const staffIds = s.rows.map((row) => row.id);
    let staffPayments = [];
    if (staffIds.length) {
      const { rows } = await q('select * from staff_payments where staff_id = any($1::bigint[])', [staffIds]);
      staffPayments = rows;
    }
    // kontrat_taksitler'in de kendi isletme_id'si yok (kontrat_id üzerinden bağlı).
    const contractIds = c.rows.map((row) => row.id);
    let contractInstallments = [];
    if (contractIds.length) {
      const { rows } = await q('select * from kontrat_taksitler where kontrat_id = any($1::bigint[]) order by taksit_no, id', [contractIds]);
      contractInstallments = rows;
    }
    res.json({
      apartments: a.rows,
      payments: p.rows,
      expenses: e.rows,
      staff: s.rows,
      staffPayments,
      maintenanceItems: mi.rows,
      gelirler: g.rows,
      contracts: c.rows,
      contractInstallments,
      projeler: pr.rows,
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
    const { isletme_id, aciklama, tutar, tarih, durum, not_metni, proje_id, taraf, odeme_sekli, fatura_no, kdv_orani, kdv_tutari } = req.body || {};
    const { rows } = await q(
      `insert into gelirler (isletme_id, aciklama, tutar, tarih, durum, not_metni, proje_id, taraf, odeme_sekli, fatura_no, kdv_orani, kdv_tutari)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [isletme_id, aciklama ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null, proje_id ?? null, taraf ?? null, odeme_sekli ?? null, fatura_no ?? null, kdv_orani ?? null, kdv_tutari ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/gelirler/:id', requireAuth, async (req, res) => {
  try {
    const { aciklama, tutar, tarih, durum, not_metni, proje_id, taraf, odeme_sekli, fatura_no, kdv_orani, kdv_tutari } = req.body || {};
    // Bir kontrattan otomatik oluşan gelirin tutarı burada elle değiştirilirse
    // (ör. sözleşme tutarından farklı net bir tutar girildiyse), tutar_manuel
    // işaretlenir ki kontrat bir sonraki güncellemesinde bu tutarı geri ezmesin.
    const { rows: existingRows } = await q('select kontrat_id from gelirler where id = $1', [req.params.id]);
    const kontratGeliriMi = !!(existingRows[0] && existingRows[0].kontrat_id);
    const { rows } = await q(
      `update gelirler set aciklama = $2, tutar = $3, tarih = $4, durum = $5, not_metni = $6, proje_id = $7, taraf = $9,
         odeme_sekli = $10, fatura_no = $11, kdv_orani = $12, kdv_tutari = $13,
         tutar_manuel = case when $8::boolean then true else tutar_manuel end
       where id = $1 returning *`,
      [req.params.id, aciklama ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null, proje_id ?? null, kontratGeliriMi, taraf ?? null, odeme_sekli ?? null, fatura_no ?? null, kdv_orani ?? null, kdv_tutari ?? null]
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
// Kontratlar (ofis/inşaat gibi 'genel' tipi işletmelerde — satılık/kiralık kontrat takibi)
// ------------------------------------------------------------------
const CONTRACT_RETURNING = `id, isletme_id, mulk_adi, tip, karsi_taraf, tutar, baslangic_tarihi, bitis_tarihi, durum, not_metni,
  belge_ad, belge_tip, (belge_data is not null) as has_belge, proje_id, gelir_olustur, created_at`;

// Gider listesinde her satırın belge_data'sı (base64) yer kaplamasın diye burada da
// has_belge boolean'ı ile döndürüyoruz — ham içerik ayrı bir uç noktadan (/api/expenses/:id/belge) gelir.
const EXPENSE_RETURNING = `id, isletme_id, ay, gider_turu, firma, taraf, tutar, tarih, durum, not_metni, bakim_id, proje_id, kategori,
  kontrat_id, taksit_id, tutar_manuel, kdv_tevkifat_tutar, odeme_sekli, fatura_no, kdv_orani, kdv_tutari, belge_ad, belge_tip, (belge_data is not null) as has_belge`;

// Personel: inşaat işçileri için SGK belgesi (hizmet dökümü, tahakkuk fişi vb.) ve hangi
// projede çalıştığı eklenebilir. Liste sorgusunda belge_data (base64) yer kaplamasın diye
// has_belge boolean'ı döner, ham içerik /api/staff/:id/belge uç noktasından gelir.
const STAFF_RETURNING = `id, isletme_id, isim, gorev, aylik_ucret, proje_id,
  belge_ad, belge_tip, (belge_data is not null) as has_belge`;

// Bir kontrat imzalandığı an, yönüne göre ya Gelir ya da Gider tarafında sayılır:
// Satılık/Kiralık/Malik Anlaşması → para İÇERİ girer, otomatik bir Gelir kaydı tutulur.
// Taşeron → para DIŞARI çıkar, otomatik bir Gider kaydı tutulur.
// Kontrat her güncellendiğinde/silindiğinde bu kayıt da senkron kalır.
// "gelecek" (henüz kesinleşmemiş) kontratların kaydı "ÖDENMEDİ" (beklemede) sayılır,
// "aktif"/"tamamlandi" olanlarınki "ÖDENDİ" sayılır.
// gelir_olustur=false ise (ör. geçmişe ait, tutarı zaten elle girilmiş bir kontrat)
// hiç otomatik kayıt oluşturulmaz/varsa silinir.
// tutar_manuel=true olan bir kaydın tutarı (ortak payı/indirim yüzünden net tutar
// sözleşmedekinden farklıysa elle değiştirilmiş demektir) kontrat güncellemesinde ezilmez.
const KONTRAT_GELIR_TIPLERI = ['satilik', 'kiralik', 'malik'];
const KONTRAT_TIP_LABELS = { satilik: 'Satılık', kiralik: 'Kiralık', malik: 'Malik Anlaşması', taseron: 'Taşeron' };
function kontratGelirDurum(kontratDurum) {
  return kontratDurum === 'gelecek' ? 'ÖDENMEDİ' : 'ÖDENDİ';
}
function kontratFinansAciklama(c) {
  const tipLabel = KONTRAT_TIP_LABELS[c.tip] || 'Satılık';
  const parca = [c.mulk_adi, c.karsi_taraf].filter(Boolean).join(' - ');
  const yon = KONTRAT_GELIR_TIPLERI.includes(c.tip) ? 'geliri' : 'gideri';
  return `Kontrat ${yon}: ${parca || 'Mülk'} (${tipLabel})`;
}
// Bir kontrat taksitli (peşinat + N taksit) satılmış olabilir — bu durumda kontratın
// tek bir gelir/gider satırı yerine, her taksit için AYRI bir gelir/gider satırı tutulur
// (taksit_id ile eşleştirilir), böylece hangi taksidin tahsil/ödenmiş olduğu ayrı ayrı
// işaretlenebilir. Bir taksit satırı ilk oluştuğunda durum her zaman "ÖDENMEDİ" ve tarihi
// taksidin vade tarihidir; sonrasında kullanıcı bunu Gelir/Gider sayfasından kendi yönetir —
// sonraki senkronizasyonlar durum/tarihe DOKUNMAZ (sadece tutar_manuel değilse tutarı,
// ve taraf/açıklama/proje gibi kontrattan gelen bilgileri tazeler).
async function syncContractFinans(contract) {
  if (!contract) return;
  const gelirYonlu = KONTRAT_GELIR_TIPLERI.includes(contract.tip);
  const dogruTablo = gelirYonlu ? 'gelirler' : 'expenses';
  const yanlisTablo = gelirYonlu ? 'expenses' : 'gelirler';
  // Kontratın tipi değişmiş olabilir (ör. Malik'ten Taşeron'a) — yanlış yöndeki eski kaydı temizle.
  await q(`delete from ${yanlisTablo} where kontrat_id = $1`, [contract.id]);

  if (contract.gelir_olustur === false) {
    await q(`delete from ${dogruTablo} where kontrat_id = $1`, [contract.id]);
    return;
  }

  const { rows: taksitler } = await q(
    'select * from kontrat_taksitler where kontrat_id = $1 order by taksit_no, id',
    [contract.id]
  );
  const notMetni = 'Bu kayıt, ilgili kontrattan otomatik oluşturuldu/güncellendi. Değiştirmek için Kontratlar sekmesinden kontratı düzenleyin.';

  if (taksitler.length) {
    // Artık plan dışında kalmış (silinmiş) taksitlere ait eski satırları temizle.
    const gecerliIdler = taksitler.map((t) => t.id);
    await q(
      `delete from ${dogruTablo} where kontrat_id = $1 and (taksit_id is null or not (taksit_id = any($2::bigint[])))`,
      [contract.id, gecerliIdler]
    );
    for (const taksit of taksitler) {
      const aciklama = `${kontratFinansAciklama(contract)} — ${taksit.taksit_no || ''}. Taksit`.replace('—  .', '—');
      const { rows: existing } = await q(`select id from ${dogruTablo} where taksit_id = $1`, [taksit.id]);
      if (gelirYonlu) {
        if (existing.length) {
          await q(
            `update gelirler set aciklama = $2, tutar = case when tutar_manuel then tutar else $3 end,
               proje_id = $4, not_metni = $5, taraf = $6 where taksit_id = $1`,
            [taksit.id, aciklama, taksit.tutar ?? null, contract.proje_id ?? null, notMetni, contract.karsi_taraf ?? null]
          );
        } else {
          await q(
            `insert into gelirler (isletme_id, aciklama, tutar, tarih, durum, proje_id, not_metni, kontrat_id, taraf, taksit_id)
             values ($1,$2,$3,$4,'ÖDENMEDİ',$5,$6,$7,$8,$9)`,
            [contract.isletme_id, aciklama, taksit.tutar ?? null, taksit.vade_tarihi, contract.proje_id ?? null, notMetni, contract.id, contract.karsi_taraf ?? null, taksit.id]
          );
        }
      } else {
        if (existing.length) {
          await q(
            `update expenses set gider_turu = $2, firma = $3, tutar = case when tutar_manuel then tutar else $4 end,
               proje_id = $5, not_metni = $6, taraf = $7, kategori = 'sabit' where taksit_id = $1`,
            [taksit.id, KONTRAT_TIP_LABELS.taseron, contract.karsi_taraf ?? null, taksit.tutar ?? null, contract.proje_id ?? null, notMetni, contract.karsi_taraf ?? null]
          );
        } else {
          await q(
            `insert into expenses (isletme_id, gider_turu, firma, tutar, tarih, durum, proje_id, not_metni, kontrat_id, taraf, kategori, taksit_id)
             values ($1,$2,$3,$4,$5,'ÖDENMEDİ',$6,$7,$8,$9,'sabit',$10)`,
            [contract.isletme_id, KONTRAT_TIP_LABELS.taseron, contract.karsi_taraf ?? null, taksit.tutar ?? null, taksit.vade_tarihi, contract.proje_id ?? null, notMetni, contract.id, contract.karsi_taraf ?? null, taksit.id]
          );
        }
      }
    }
    return;
  }

  // Taksitsiz (basit/peşin) plan: tek satır, kontrat_id ile eşleştirilir.
  await q(`delete from ${dogruTablo} where kontrat_id = $1 and taksit_id is not null`, [contract.id]);
  const durum = kontratGelirDurum(contract.durum);
  const aciklama = kontratFinansAciklama(contract);
  const tarih = contract.baslangic_tarihi || new Date().toISOString().slice(0, 10);
  const { rows: existing } = await q(`select id from ${dogruTablo} where kontrat_id = $1 and taksit_id is null`, [contract.id]);
  if (gelirYonlu) {
    if (existing.length) {
      await q(
        `update gelirler set aciklama = $2, tutar = case when tutar_manuel then tutar else $3 end,
           tarih = $4, durum = $5, proje_id = $6, not_metni = $7, taraf = $8 where kontrat_id = $1 and taksit_id is null`,
        [contract.id, aciklama, contract.tutar ?? null, tarih, durum, contract.proje_id ?? null, notMetni, contract.karsi_taraf ?? null]
      );
    } else {
      await q(
        `insert into gelirler (isletme_id, aciklama, tutar, tarih, durum, proje_id, not_metni, kontrat_id, taraf)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [contract.isletme_id, aciklama, contract.tutar ?? null, tarih, durum, contract.proje_id ?? null, notMetni, contract.id, contract.karsi_taraf ?? null]
      );
    }
  } else {
    if (existing.length) {
      await q(
        `update expenses set gider_turu = $2, firma = $3, tutar = case when tutar_manuel then tutar else $4 end,
           tarih = $5, durum = $6, proje_id = $7, not_metni = $8, taraf = $9, kategori = 'sabit' where kontrat_id = $1 and taksit_id is null`,
        [contract.id, KONTRAT_TIP_LABELS.taseron, contract.karsi_taraf ?? null, contract.tutar ?? null, tarih, durum, contract.proje_id ?? null, notMetni, contract.karsi_taraf ?? null]
      );
    } else {
      await q(
        `insert into expenses (isletme_id, gider_turu, firma, tutar, tarih, durum, proje_id, not_metni, kontrat_id, taraf, kategori)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sabit')`,
        [contract.isletme_id, KONTRAT_TIP_LABELS.taseron, contract.karsi_taraf ?? null, contract.tutar ?? null, tarih, durum, contract.proje_id ?? null, notMetni, contract.id, contract.karsi_taraf ?? null]
      );
    }
  }
}

app.post('/api/contracts', requireAuth, async (req, res) => {
  try {
    const { isletme_id, mulk_adi, tip, karsi_taraf, tutar, baslangic_tarihi, bitis_tarihi, durum, not_metni, belge_ad, belge_tip, belge_data, proje_id, gelir_olustur } = req.body || {};
    if (!isletme_id) return res.status(400).json({ error: 'isletme_id gerekli' });
    const { rows } = await q(
      `insert into contracts (isletme_id, mulk_adi, tip, karsi_taraf, tutar, baslangic_tarihi, bitis_tarihi, durum, not_metni, belge_ad, belge_tip, belge_data, proje_id, gelir_olustur)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning ${CONTRACT_RETURNING}`,
      [
        isletme_id,
        mulk_adi ?? null,
        ['satilik', 'kiralik', 'malik', 'taseron'].includes(tip) ? tip : 'satilik',
        karsi_taraf ?? null,
        tutar ?? null,
        baslangic_tarihi ?? null,
        bitis_tarihi ?? null,
        ['aktif', 'tamamlandi', 'gelecek'].includes(durum) ? durum : 'aktif',
        not_metni ?? null,
        belge_ad ?? null,
        belge_tip ?? null,
        belge_data ?? null,
        proje_id ?? null,
        gelir_olustur === false ? false : true,
      ]
    );
    await syncContractFinans(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contracts/:id', requireAuth, async (req, res) => {
  try {
    const { mulk_adi, tip, karsi_taraf, tutar, baslangic_tarihi, bitis_tarihi, durum, not_metni, belge_ad, belge_tip, belge_data, remove_belge, proje_id, gelir_olustur } = req.body || {};
    const { rows } = await q(
      `update contracts set
         mulk_adi = $2,
         tip = $3,
         karsi_taraf = $4,
         tutar = $5,
         baslangic_tarihi = $6,
         bitis_tarihi = $7,
         durum = $8,
         not_metni = $9,
         belge_ad = case when $10::boolean then null when $11::text is not null then $11 else belge_ad end,
         belge_tip = case when $10::boolean then null when $12::text is not null then $12 else belge_tip end,
         belge_data = case when $10::boolean then null when $13::text is not null then $13 else belge_data end,
         proje_id = $14,
         gelir_olustur = $15
       where id = $1
       returning ${CONTRACT_RETURNING}`,
      [
        req.params.id,
        mulk_adi ?? null,
        ['satilik', 'kiralik', 'malik', 'taseron'].includes(tip) ? tip : 'satilik',
        karsi_taraf ?? null,
        tutar ?? null,
        baslangic_tarihi ?? null,
        bitis_tarihi ?? null,
        ['aktif', 'tamamlandi', 'gelecek'].includes(durum) ? durum : 'aktif',
        not_metni ?? null,
        !!remove_belge,
        belge_ad ?? null,
        belge_tip ?? null,
        belge_data ?? null,
        proje_id ?? null,
        gelir_olustur === false ? false : true,
      ]
    );
    await syncContractFinans(rows[0]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Bir kontratın taksitli ödeme planını tamamen değiştirir (satılık/malik anlaşmalarında
// peşinat + taksitler; taşeronda da hakediş bazlı ödeme planı için kullanılabilir).
// Gönderilen listedeki id'si olan satırlar güncellenir (taksit_id sabit kalır, bağlı
// gelir/gider kaydının durumu/tarihi korunur), id'siz olanlar yeni taksit olarak eklenir,
// listede artık olmayan eski taksitler silinir (bağlı gelir/gider kaydı da cascade ile silinir).
app.put('/api/contracts/:id/taksitler', requireAuth, async (req, res) => {
  try {
    const kontratId = Number(req.params.id);
    const list = Array.isArray((req.body || {}).taksitler) ? req.body.taksitler : [];
    const { rows: existing } = await q('select id from kontrat_taksitler where kontrat_id = $1', [kontratId]);
    const existingIds = new Set(existing.map((r) => Number(r.id)));
    const keepIds = new Set();
    let taksitNo = 0;
    for (const t of list) {
      taksitNo += 1;
      const tarih = t.tarih ?? t.vade_tarihi ?? null;
      const tutar = t.tutar ?? null;
      if (t.id && existingIds.has(Number(t.id))) {
        await q('update kontrat_taksitler set taksit_no = $2, vade_tarihi = $3, tutar = $4 where id = $1', [Number(t.id), taksitNo, tarih, tutar]);
        keepIds.add(Number(t.id));
      } else {
        const { rows } = await q(
          'insert into kontrat_taksitler (kontrat_id, taksit_no, vade_tarihi, tutar) values ($1,$2,$3,$4) returning id',
          [kontratId, taksitNo, tarih, tutar]
        );
        keepIds.add(Number(rows[0].id));
      }
    }
    const silinecekler = [...existingIds].filter((id) => !keepIds.has(id));
    if (silinecekler.length) {
      await q('delete from kontrat_taksitler where id = any($1::bigint[])', [silinecekler]);
    }
    const { rows: cRows } = await q(`select ${CONTRACT_RETURNING} from contracts where id = $1`, [kontratId]);
    if (!cRows.length) return res.status(404).json({ error: 'Kontrat bulunamadı' });
    await syncContractFinans(cRows[0]);
    const { rows: taksitRows } = await q('select * from kontrat_taksitler where kontrat_id = $1 order by taksit_no, id', [kontratId]);
    res.json({ contract: cRows[0], taksitler: taksitRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Projeler (bir şirketin içindeki inşaat/mimarlık projeleri — gelir, gider ve
// kontrat kayıtları isteğe bağlı olarak bir projeye etiketlenebilir; etiketlenmeyenler
// "Ofis Geneli" sayılır)
// ------------------------------------------------------------------
app.post('/api/projeler', requireAuth, async (req, res) => {
  try {
    const { isletme_id, ad, aciklama, durum } = req.body || {};
    if (!isletme_id || !ad) return res.status(400).json({ error: 'isletme_id ve ad gerekli' });
    const { rows } = await q(
      `insert into projeler (isletme_id, ad, aciklama, durum)
       values ($1, $2, $3, $4) returning *`,
      [isletme_id, ad, aciklama ?? null, ['aktif', 'tamamlandi', 'beklemede'].includes(durum) ? durum : 'aktif']
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projeler/:id', requireAuth, async (req, res) => {
  try {
    const { ad, aciklama, durum } = req.body || {};
    const { rows } = await q(
      `update projeler set
         ad = coalesce($2, ad),
         aciklama = $3,
         durum = coalesce($4, durum)
       where id = $1 returning *`,
      [req.params.id, ad ?? null, aciklama ?? null, ['aktif', 'tamamlandi', 'beklemede'].includes(durum) ? durum : null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projeler/:id', requireAuth, async (req, res) => {
  try {
    // Bu projeye bağlı gelir/gider/kontrat kayıtları silinmez, sadece "Ofis Geneli"ne geri döner.
    await q('delete from projeler where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contracts/:id', requireAuth, async (req, res) => {
  try {
    // Kontrata bağlı otomatik gelir/gider kaydı hangi yöndeyse onu da temizle.
    await q('delete from gelirler where kontrat_id = $1', [req.params.id]);
    await q('delete from expenses where kontrat_id = $1', [req.params.id]);
    await q('delete from contracts where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Belge (sözleşme PDF/fotoğrafı) indirme/görüntüleme — base64 olarak saklanan içeriği ham dosya olarak döner
app.get('/api/contracts/:id/belge', requireAuth, async (req, res) => {
  try {
    const { rows } = await q('select belge_ad, belge_tip, belge_data from contracts where id = $1', [req.params.id]);
    const row = rows[0];
    if (!row || !row.belge_data) return res.status(404).json({ error: 'Belge bulunamadı' });
    const buffer = Buffer.from(row.belge_data, 'base64');
    res.set('Content-Type', row.belge_tip || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(row.belge_ad || 'belge').replace(/"/g, '')}"`);
    res.send(buffer);
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

// Gider "Sabit Gider" mi yoksa "Extra Harcama" mı? Ön uçtan geldiyse onu kullan;
// gelmediyse (ör. sohbet asistanından eklenirse) gider türü metnine bakarak tahmin et.
function guessExpenseKategori(giderTuru, provided) {
  if (provided === 'sabit' || provided === 'extra') return provided;
  const t = (giderTuru || '').toLocaleLowerCase('tr-TR');
  if (t.includes('kırtasiye') || t.includes('kirtasiye') || t.includes('mutfak') || t.includes('temizlik')) return 'extra';
  return 'sabit';
}

app.post('/api/expenses', requireAuth, async (req, res) => {
  try {
    const { isletme_id, ay, gider_turu, firma, taraf, tutar, tarih, durum, not_metni, bakim_id, proje_id, kategori, kdv_tevkifat_tutar, odeme_sekli, fatura_no, kdv_orani, kdv_tutari, belge_ad, belge_tip, belge_data } = req.body || {};
    const { rows } = await q(
      `insert into expenses (isletme_id, ay, gider_turu, firma, taraf, tutar, tarih, durum, not_metni, bakim_id, proje_id, kategori, kdv_tevkifat_tutar, odeme_sekli, fatura_no, kdv_orani, kdv_tutari, belge_ad, belge_tip, belge_data)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning ${EXPENSE_RETURNING}`,
      [isletme_id, ay ?? null, gider_turu ?? null, firma ?? null, taraf ?? null, tutar ?? null, tarih ?? null, durum || 'ÖDENMEDİ', not_metni ?? null, bakim_id ?? null, proje_id ?? null, guessExpenseKategori(gider_turu, kategori), kdv_tevkifat_tutar ?? null, odeme_sekli ?? null, fatura_no ?? null, kdv_orani ?? null, kdv_tutari ?? null, belge_ad ?? null, belge_tip ?? null, belge_data ?? null]
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
    const { ay, gider_turu, firma, taraf, tutar, tarih, durum, not_metni, bakim_id, proje_id, kategori, kdv_tevkifat_tutar, odeme_sekli, fatura_no, kdv_orani, kdv_tutari, belge_ad, belge_tip, belge_data, remove_belge } = req.body || {};
    // Bir kontrattan (taşeron) otomatik oluşan giderin tutarı burada elle değiştirilirse
    // (net tutar sözleşmeden farklıysa), tutar_manuel işaretlenir ki kontrat bir sonraki
    // güncellemesinde bu tutarı geri ezmesin.
    const { rows: existingRows } = await q('select kontrat_id from expenses where id = $1', [req.params.id]);
    const kontratGideriMi = !!(existingRows[0] && existingRows[0].kontrat_id);
    const { rows } = await q(
      `update expenses set ay = $2, gider_turu = $3, firma = $4, taraf = $5, tutar = $6, tarih = $7, durum = $8, not_metni = $9,
         bakim_id = $10, proje_id = $11, kategori = $12, kdv_tevkifat_tutar = $13,
         odeme_sekli = $19, fatura_no = $20, kdv_orani = $21, kdv_tutari = $22,
         belge_ad = case when $14::boolean then null when $15::text is not null then $15 else belge_ad end,
         belge_tip = case when $14::boolean then null when $16::text is not null then $16 else belge_tip end,
         belge_data = case when $14::boolean then null when $17::text is not null then $17 else belge_data end,
         tutar_manuel = case when $18::boolean then true else tutar_manuel end
       where id = $1 returning ${EXPENSE_RETURNING}`,
      [
        req.params.id, ay ?? null, gider_turu ?? null, firma ?? null, taraf ?? null, tutar ?? null, tarih ?? null,
        durum || 'ÖDENMEDİ', not_metni ?? null, bakim_id ?? null, proje_id ?? null, guessExpenseKategori(gider_turu, kategori),
        kdv_tevkifat_tutar ?? null, !!remove_belge, belge_ad ?? null, belge_tip ?? null, belge_data ?? null, kontratGideriMi,
        odeme_sekli ?? null, fatura_no ?? null, kdv_orani ?? null, kdv_tutari ?? null,
      ]
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

// Belge (fatura/makbuz/fotoğraf) indirme/görüntüleme — base64 olarak saklanan içeriği ham dosya olarak döner
app.get('/api/expenses/:id/belge', requireAuth, async (req, res) => {
  try {
    const { rows } = await q('select belge_ad, belge_tip, belge_data from expenses where id = $1', [req.params.id]);
    const row = rows[0];
    if (!row || !row.belge_data) return res.status(404).json({ error: 'Belge bulunamadı' });
    const buffer = Buffer.from(row.belge_data, 'base64');
    res.set('Content-Type', row.belge_tip || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(row.belge_ad || 'belge').replace(/"/g, '')}"`);
    res.send(buffer);
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
    const { isletme_id, isim, gorev, aylik_ucret, proje_id, belge_ad, belge_tip, belge_data } = req.body || {};
    const { rows } = await q(
      `insert into staff (isletme_id, isim, gorev, aylik_ucret, proje_id, belge_ad, belge_tip, belge_data)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${STAFF_RETURNING}`,
      [isletme_id, isim ?? null, gorev ?? null, aylik_ucret ?? null, proje_id ?? null, belge_ad ?? null, belge_tip ?? null, belge_data ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    const { isim, gorev, aylik_ucret, proje_id, remove_belge, belge_ad, belge_tip, belge_data } = req.body || {};
    const { rows } = await q(
      `update staff set isim = $2, gorev = $3, aylik_ucret = $4, proje_id = $5,
         belge_ad = case when $6::boolean then null when $7::text is not null then $7 else belge_ad end,
         belge_tip = case when $6::boolean then null when $8::text is not null then $8 else belge_tip end,
         belge_data = case when $6::boolean then null when $9::text is not null then $9 else belge_data end
       where id = $1 returning ${STAFF_RETURNING}`,
      [req.params.id, isim ?? null, gorev ?? null, aylik_ucret ?? null, proje_id ?? null, !!remove_belge, belge_ad ?? null, belge_tip ?? null, belge_data ?? null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/staff/:id', requireAuth, async (req, res) => {
  try {
    await q('delete from staff_payments where staff_id = $1', [req.params.id]);
    await q('delete from staff where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Belge (SGK hizmet dökümü, tahakkuk fişi, kimlik vb.) indirme/görüntüleme
app.get('/api/staff/:id/belge', requireAuth, async (req, res) => {
  try {
    const { rows } = await q('select belge_ad, belge_tip, belge_data from staff where id = $1', [req.params.id]);
    const row = rows[0];
    if (!row || !row.belge_data) return res.status(404).json({ error: 'Belge bulunamadı' });
    const buffer = Buffer.from(row.belge_data, 'base64');
    res.set('Content-Type', row.belge_tip || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(row.belge_ad || 'belge').replace(/"/g, '')}"`);
    res.send(buffer);
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
// Sohbet asistanının kayıt ekleyebildiği araçlar (tool use) — kullanıcı
// "500 TL elektrik gideri ekle" gibi bir şey yazınca asistan bunu gerçekten
// veritabanına ekleyebilsin diye tanımlanır.
// ------------------------------------------------------------------
const CHAT_TOOL_ADD_EXPENSE = {
  name: 'gider_ekle',
  description:
    'Yeni bir gider (fatura, ödeme, harcama) kaydı ekler. Kullanıcı bir gider/harcama/fatura eklemeni istediğinde bu aracı kullan.',
  input_schema: {
    type: 'object',
    properties: {
      gider_turu: { type: 'string', description: 'Gider türü/açıklaması, örn. Elektrik, Su, Malzeme, Nakliye, Personel vb.' },
      firma: { type: 'string', description: 'Ödeme yapılan firma/abone/tedarikçi adı (biliniyorsa, yoksa boş bırak)' },
      tutar: { type: 'number', description: 'Tutar (TL, sayı olarak)' },
      tarih: { type: 'string', description: 'Tarih, YYYY-MM-DD formatında. Kullanıcı belirtmemişse bugünün tarihini kullan.' },
      ay: { type: 'string', description: 'Ay adı büyük harfle, örn. EYLÜL (opsiyonel)' },
      durum: { type: 'string', enum: ['ÖDENDİ', 'ÖDENMEDİ'], description: 'Ödeme durumu, belirtilmemişse ÖDENMEDİ kullan' },
      proje_id: { type: 'number', description: 'Eğer belirli bir projeye/inşaata aitse o projenin id numarası; genel ofis gideriyse boş bırak' },
      not_metni: { type: 'string', description: 'Ek not (opsiyonel)' },
    },
    required: ['tutar'],
  },
};
const CHAT_TOOL_ADD_INCOME = {
  name: 'gelir_ekle',
  description: 'Yeni bir gelir kaydı ekler (para geldiğinde/tahsilat olduğunda). Sadece ofis/inşaat tipi işletmelerde kullanılır.',
  input_schema: {
    type: 'object',
    properties: {
      aciklama: { type: 'string', description: 'Gelirin açıklaması, örn. "3 nolu daire satışı", "ofis kirası"' },
      tutar: { type: 'number', description: 'Tutar (TL, sayı olarak)' },
      tarih: { type: 'string', description: 'Tarih, YYYY-MM-DD formatında. Belirtilmemişse bugünün tarihini kullan.' },
      durum: { type: 'string', enum: ['ÖDENDİ', 'ÖDENMEDİ'], description: 'Belirtilmemişse ÖDENDİ kullan (para geldiyse)' },
      proje_id: { type: 'number', description: 'Eğer belirli bir projeye/inşaata aitse o projenin id numarası; genel ofis geliriyse boş bırak' },
      not_metni: { type: 'string', description: 'Ek not (opsiyonel)' },
    },
    required: ['tutar'],
  },
};

async function runChatTool(name, input, isletme_id) {
  const todayISO = new Date().toISOString().slice(0, 10);
  if (name === 'gider_ekle') {
    const { gider_turu, firma, tutar, tarih, ay, durum, proje_id, not_metni } = input || {};
    const { rows } = await q(
      `insert into expenses (isletme_id, ay, gider_turu, firma, tutar, tarih, durum, not_metni, proje_id, kategori)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [isletme_id, ay ?? null, gider_turu ?? null, firma ?? null, tutar ?? null, tarih || todayISO, durum || 'ÖDENMEDİ', not_metni ?? null, proje_id ?? null, guessExpenseKategori(gider_turu)]
    );
    return { ok: true, summary: `Gider eklendi: ${gider_turu || firma || 'gider'} — ${Number(tutar || 0).toLocaleString('tr-TR')} ₺ (kayıt no ${rows[0].id})` };
  }
  if (name === 'gelir_ekle') {
    const { aciklama, tutar, tarih, durum, proje_id, not_metni } = input || {};
    const { rows } = await q(
      `insert into gelirler (isletme_id, aciklama, tutar, tarih, durum, not_metni, proje_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [isletme_id, aciklama ?? null, tutar ?? null, tarih || todayISO, durum || 'ÖDENDİ', not_metni ?? null, proje_id ?? null]
    );
    return { ok: true, summary: `Gelir eklendi: ${aciklama || 'gelir'} — ${Number(tutar || 0).toLocaleString('tr-TR')} ₺ (kayıt no ${rows[0].id})` };
  }
  return { ok: false, summary: 'Bilinmeyen işlem: ' + name };
}

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
    let tools = [];

    if (isSite) {
      tools = [CHAT_TOOL_ADD_EXPENSE];
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

Her zaman Türkçe, kısa ve net cevaplar ver. Kesin hukuki veya vergisel sonucu olan konularda (ceza, dava süreci, vergi mükellefiyeti gibi) genel bilgi verebilirsin ama bunun bağlayıcı hukuki/mali tavsiye olmadığını, kesinleşmesi gereken konularda bir mali müşavir veya avukata danışılmasını belirt. Aşağıda uygulamanın güncel veri özeti var, sorular buna göre yanıtlanabilir; ama tam liste/detay gerekiyorsa yöneticiye uygulama içindeki ilgili sekmeye bakmasını söyle (elinde satır satır veri yok, sadece bu özet var).\n\nÖNEMLİ: Yönetici sana "şu kadar TL elektrik gideri ekle", "500 TL fatura ödedim, kaydet" gibi bir gider/fatura eklemeni söylerse, ona nasıl ekleyeceğini anlatmak yerine "gider_ekle" aracını kullanarak kaydı SEN DOĞRUDAN EKLE. Tutar ve tür gibi temel bilgiler yeterli, eksik detay (firma, tarih vb.) için illa soru sorman gerekmez, makul varsayımlarla ekleyip sonucu özetle.\n\nGÜNCEL DURUM:\n${context}`;
    } else {
      tools = [CHAT_TOOL_ADD_EXPENSE, CHAT_TOOL_ADD_INCOME];
      const [{ rows: gelirler }, { rows: expenses }, { rows: contracts }, { rows: projeler }] = await Promise.all([
        q('select * from gelirler where isletme_id = $1', [isletme_id]),
        q('select * from expenses where isletme_id = $1', [isletme_id]),
        q('select mulk_adi, tip, karsi_taraf, tutar, durum, proje_id from contracts where isletme_id = $1', [isletme_id]),
        q('select id, ad, durum from projeler where isletme_id = $1', [isletme_id]),
      ]);
      const gelirToplam = (gelirler || []).filter((g) => g.durum === 'ÖDENDİ').reduce((s, g) => s + (Number(g.tutar) || 0), 0);
      const giderToplam = (expenses || []).filter((e) => e.durum === 'ÖDENDİ').reduce((s, e) => s + (Number(e.tutar) || 0), 0);
      const aktifKontrat = (contracts || []).filter((k) => k.durum === 'aktif');
      const satilikSayisi = (contracts || []).filter((k) => k.tip === 'satilik').length;
      const kiralikSayisi = (contracts || []).filter((k) => k.tip === 'kiralik').length;

      const projeSatirlari = (projeler || []).map((proje) => {
        const pg = (gelirler || []).filter((g) => g.proje_id === proje.id && g.durum === 'ÖDENDİ').reduce((s, g) => s + (Number(g.tutar) || 0), 0);
        const pe = (expenses || []).filter((e) => e.proje_id === proje.id && e.durum === 'ÖDENDİ').reduce((s, e) => s + (Number(e.tutar) || 0), 0);
        return `- ${proje.ad} (id: ${proje.id}, durum: ${proje.durum}): gelir ${pg.toLocaleString('tr-TR')} ₺, gider ${pe.toLocaleString('tr-TR')} ₺, net ${(pg - pe).toLocaleString('tr-TR')} ₺`;
      }).join('\n');

      context = `
Toplam gelen para (ödendi işaretli): ${gelirToplam.toLocaleString('tr-TR')} ₺
Toplam ödenen gider: ${giderToplam.toLocaleString('tr-TR')} ₺
Net durum: ${(gelirToplam - giderToplam).toLocaleString('tr-TR')} ₺
Toplam kontrat sayısı: ${(contracts || []).length} (Satılık: ${satilikSayisi}, Kiralık: ${kiralikSayisi}, Aktif: ${aktifKontrat.length})
${projeler && projeler.length ? `\nProjeler (id numaralarıyla birlikte):\n${projeSatirlari}` : ''}
`.trim();

      system = `Sen "${isletmeAdi}" işletmesinin (ofis, inşaat veya gayrimenkul projesi olabilir) muhasebe ve iş takibi asistanısın. Deneyimli bir mali müşavir gibi net, pratik ve güven verici konuş. Gelir ve gider kayıtları, personel maaş takibi, satılık/kiralık kontrat durumu hakkında sorulara yardımcı ol. Uygulamada "Kontratlar" sekmesinde satılık/kiralık mülk kontratlarının (karşı taraf, tutar, tarih, durum, belge) tutulduğunu, "Projeler" sekmesinde ise şirketin birden fazla inşaat/mimarlık projesinin her birinin kendi gelir-gider-kontrat kayıtlarıyla ayrı takip edildiğini, projeye bağlanmayan kayıtların "Ofis Geneli" sayıldığını biliyorsun; ilgili sorularda oraya yönlendirebilirsin. Kesin hukuki/vergisel konularda genel bilgi verip bir mali müşavir/avukata danışılmasını öner. Türkçe, kısa ve net cevaplar ver.\n\nÖNEMLİ: Yönetici sana bir gider/fatura ("500 TL elektrik gideri ekle") veya bir gelir/tahsilat ("10.000 TL kira geliri geldi, kaydet") eklemeni söylerse, nasıl ekleyeceğini anlatmak yerine ilgili aracı ("gider_ekle" veya "gelir_ekle") kullanarak kaydı SEN DOĞRUDAN EKLE. Kullanıcı bir proje/inşaat adı söylerse (örn. "Bahçelievler projesine ekle"), yukarıdaki proje listesinden doğru proje id'sini bul ve kullan; proje belirtmezse proje_id'yi boş bırak (Ofis Geneli sayılır). Eksik detaylar için illa soru sormana gerek yok, makul varsayımlarla (tarih belirtilmemişse bugün, durum belirtilmemişse gidercte ÖDENMEDİ / gelirde ÖDENDİ) ekleyip sonucu kısaca özetle.\n\nGÜNCEL DURUM:\n${context}`;
    }

    let messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }];
    let finalText = '';
    let changed = false;

    for (let round = 0; round < 5; round++) {
      const msg = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 1024,
        system,
        tools: tools.length ? tools : undefined,
        messages,
      });

      const textBlock = msg.content.find((b) => b.type === 'text');
      if (textBlock) finalText = textBlock.text;

      const toolUses = msg.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content: msg.content });
      const toolResults = [];
      for (const tu of toolUses) {
        let resultText;
        try {
          const result = await runChatTool(tu.name, tu.input, isletme_id);
          if (result.ok) changed = true;
          resultText = result.summary;
        } catch (err) {
          resultText = 'Hata: ' + err.message;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    res.json({ response: finalText, changed });
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
