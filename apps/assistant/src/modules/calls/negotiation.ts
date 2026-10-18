/**
 * Owner-set price limits for negotiation calls. The limit is read from the owner's own words by plain code (never by the model), travels in
 * the sealed call plan, and is checked in code when the AI wants to accept an amount: "don't sell below 10000 USD" can not be argued away.
 */
export type Currency = 'USD' | 'UZS' | 'EUR' | 'RUB';

export interface PriceLimit {
  /** `min`: never accept less (the owner sells); `max`: never accept more (the owner buys). */
  kind: 'min' | 'max';
  amount: number;
  currency: Currency;
}

export const LIMIT_PREFIX = 'limit:';

const CUR = String.raw`(\$|usd|dollar\w*|доллар\w*|so'?m|sum|uzs|сум\w*|eur|euro|yevro|€|евро|rub|₽|rubl\w*|руб\w*)`;
const MULT = String.raw`(?:\s*(mln|million\w*|миллион\w*|ming|k|тыс\w*|т\.?)(?![\p{L}]))?`;
const NUM = String.raw`(\d{1,3}(?:[ .,']\d{3})+|\d+(?:[.,]\d+)?)`;
const FILL = String.raw`(?:(?:aqsh|as?h|amerika\w*|us|american)\s+)?`;
const AMOUNT = new RegExp(String.raw`(?:${CUR}\s*${NUM}${MULT}|${NUM}${MULT}\s*${FILL}${CUR})`, 'iu');
// Words that say "not below" (sell floor) and "not above" (buy ceiling), anywhere after the amount.
const FLOOR =
  /(?<![\p{L}])(?:past|kam|arzon|kamiga|ostida|dan\s+past|below|under|less|lower|cheaper|ниже|дешевле|меньше)(?![\p{L}])|(?<![\p{L}])(?:dan\s+)?(?:kam|past|arzon)\w*|(?<![\p{L}])minimum(?![\p{L}])|(?<![\p{L}])at\s+least(?![\p{L}])|(?<![\p{L}])no\s+less(?![\p{L}])|(?<![\p{L}])не\s+ниже(?![\p{L}])|(?<![\p{L}])камида(?![\p{L}])/iu;
const CEILING =
  /(?<![\p{L}])(?:yuqori|ko'?p|qimmat|pastroq|above|over|more|higher|expensive|выше|дороже|больше)(?![\p{L}])|(?<![\p{L}])maximum(?![\p{L}])|(?<![\p{L}])at\s+most(?![\p{L}])|(?<![\p{L}])no\s+more(?![\p{L}])|(?<![\p{L}])не\s+выше(?![\p{L}])/iu;
const SELL = /(?<![\p{L}])sot\w*|(?<![\p{L}])sell\w*|(?<![\p{L}])прод\w*/iu;
const BUY = /(?<![\p{L}])(?:sotib\s+ol|ol(?:ma|mang)|buy\w*|купи\w*|покуп\w*|to'?la(?:ma|ng)|pay\w*|плат\w*)/iu;

function toCurrency(raw: string): Currency {
  const s = raw.toLowerCase();
  if (s === '$' || s.startsWith('usd') || s.startsWith('doll') || s.startsWith('долл')) return 'USD';
  if (s === '€' || s.startsWith('eur') || s.startsWith('yevro') || s.startsWith('евро')) return 'EUR';
  if (s === '₽' || s.startsWith('rub') || s.startsWith('руб')) return 'RUB';
  return 'UZS';
}

export function parseAmount(num: string, mult: string | undefined): number | undefined {
  let s = num.replace(/[ ']/g, '');
  // "10.000" / "10,000" (thousands) vs "10.5" (decimal)
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else s = s.replace(',', '.');
  let n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const m = (mult ?? '').toLowerCase();
  if (/^(mln|million|миллион)/.test(m)) n *= 1_000_000;
  else if (/^(ming|k|тыс|т)/.test(m)) n *= 1000;
  return Math.round(n);
}

const UNITS: Record<string, number> = { bir: 1, ikki: 2, uch: 3, "to'rt": 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, "to'qqiz": 9 };
const TENS: Record<string, number> = { "o'n": 10, yigirma: 20, "o'ttiz": 30, qirq: 40, ellik: 50, oltmish: 60, yetmish: 70, sakson: 80, "to'qson": 90 };

/** "o'n ikki ming dollar" -> "12000 dollar": amounts spoken in Uzbek words (the owner often says them in a voice call). */
export function uzNumberWordsToDigits(text: string): string {
  const parts = text.replace(/[ʻʼ‘’`´]/g, "'").split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  const isNum = (w: string) => w in UNITS || w in TENS || w === 'yuz' || w === 'ming' || w === 'million' || w === 'mln';
  while (i < parts.length) {
    const w = (parts[i] ?? '').toLowerCase();
    // A run starts at a unit/ten/"yuz": a bare "ming"/"mln" after digits ("10 ming", "50 mln") is left for the digit parser.
    if (!(w in UNITS || w in TENS || w === 'yuz')) {
      out.push(parts[i] ?? '');
      i++;
      continue;
    }
    let total = 0;
    let cur = 0;
    let j = i;
    while (j < parts.length) {
      const x = (parts[j] ?? '').toLowerCase();
      if (/^\s+$/.test(x)) {
        j++;
        continue;
      }
      if (!isNum(x)) break;
      if (x in UNITS) cur += UNITS[x]!;
      else if (x in TENS) cur += TENS[x]!;
      else if (x === 'yuz') cur = (cur || 1) * 100;
      else if (x === 'ming') {
        total += (cur || 1) * 1000;
        cur = 0;
      } else {
        total += (cur || 1) * 1_000_000;
        cur = 0;
      }
      j++;
    }
    out.push(String(total + cur), ' ');
    i = j;
  }
  return out.join('');
}

/** Finds the price limits the owner stated in a task ("Onix ni sot, lekin 10000 usd dan past sotma"). Returns [] when none is clear. */
export function extractPriceLimits(text: string): PriceLimit[] {
  const out: PriceLimit[] = [];
  const clauses = uzNumberWordsToDigits(text)
    .replace(/[«»]/g, ' ')
    .split(/[.;!?\n]|,\s+(?=lekin|ammo|but|но)|\s(?:lekin|ammo|but|но)\s/iu)
    .filter(Boolean);
  const whole = text;
  for (const clause of clauses) {
    const m = AMOUNT.exec(clause);
    if (!m) continue;
    const cur = m[1] ?? m[6];
    const num = m[2] ?? m[4];
    const mult = m[3] ?? m[5];
    const amount = num ? parseAmount(num, mult) : undefined;
    if (!cur || !amount) continue;
    const floor = FLOOR.test(clause);
    const ceil = CEILING.test(clause);
    if (!floor && !ceil) continue;
    const selling = SELL.test(whole) && !BUY.test(clause);
    const buying = BUY.test(clause) && !SELL.test(clause);
    // "10000 dan past SOTMA / do not sell below" -> floor. "10000 dan ko'p TO'LAMA / not above" -> ceiling.
    let kind: 'min' | 'max';
    if (floor && !ceil) kind = buying ? 'max' : 'min';
    else if (ceil && !floor) kind = selling && !buying ? 'min' : 'max';
    else kind = selling ? 'min' : 'max';
    // "dan past sotma" is a floor when selling; "dan ko'p to'lama" a ceiling when buying; a plain price word next to a sell verb is a floor.
    out.push({ kind, amount, currency: toCurrency(cur) });
  }
  const seen = new Set<string>();
  return out.filter((l) => {
    const k = `${l.kind}:${l.currency}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const encodeLimit = (l: PriceLimit): string => `${LIMIT_PREFIX}${l.kind}:${l.amount}:${l.currency}`;

export function decodeLimit(s: string): PriceLimit | undefined {
  const m = /^limit:(min|max):(\d+):(USD|UZS|EUR|RUB)$/.exec(s);
  return m ? { kind: m[1] as 'min' | 'max', amount: Number(m[2]), currency: m[3] as Currency } : undefined;
}

export type OfferCheck =
  { acceptable: true; note: string } | { acceptable: false; reason: 'below_floor' | 'above_ceiling' | 'unknown_currency'; note: string; limit?: PriceLimit };

/** Is an amount the contact proposed inside the owner's limits? Another currency is never accepted blindly. */
export function checkOffer(limits: PriceLimit[], amount: number, currency: string): OfferCheck {
  const cur = ((): Currency | undefined => {
    const c = currency.trim().toUpperCase();
    return c === 'USD' || c === 'UZS' || c === 'EUR' || c === 'RUB' ? (c as Currency) : undefined;
  })();
  if (!cur) return { acceptable: false, reason: 'unknown_currency', note: 'Valyuta noaniq: qabul qilma, valyutani aniqlashtir yoki egasiga yetkaz.' };
  const relevant = limits.filter((l) => l.currency === cur);
  if (limits.length && !relevant.length)
    return {
      acceptable: false,
      reason: 'unknown_currency',
      note: `Egasining chegarasi ${limits[0]!.currency} da; ${cur} dagi taklifni o'zing qabul qilma, egasiga yetkaz yoki ${limits[0]!.currency} da gaplash.`,
    };
  for (const l of relevant) {
    if (l.kind === 'min' && amount < l.amount)
      return {
        acceptable: false,
        reason: 'below_floor',
        limit: l,
        note: `Bu taklif egasining quyi chegarasidan past. QABUL QILMA. Chegarani aytma. Qarshi narx ayt (chegaradan yuqori) va asoslab ber.`,
      };
    if (l.kind === 'max' && amount > l.amount)
      return {
        acceptable: false,
        reason: 'above_ceiling',
        limit: l,
        note: `Bu taklif egasining yuqori chegarasidan baland. QABUL QILMA. Chegarani aytma. Pastroq narx ayt va asoslab ber.`,
      };
  }
  return {
    acceptable: true,
    note: "Taklif egasining chegarasi ichida: uni o'zing qabul qila olasan. Boshlang'ich narxdan past bo'lsa avval 1-2 marta yuqoriroq so'ra, suhbatdosh turib olsa qabul qil va deal_reached ber.",
  };
}
