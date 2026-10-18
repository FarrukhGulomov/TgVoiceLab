import { describe, expect, it } from 'vitest';
import { checkOffer, decodeLimit, encodeLimit, extractPriceLimits } from '../../apps/assistant/src/modules/calls/negotiation.js';

describe('owner price limits', () => {
  it.each([
    ['Farruh Onix mashinasini sotmoqchi, 10000 usd dan past sotma', { kind: 'min', amount: 10000, currency: 'USD' }],
    ['Onixni sot, lekin 10 000 $ dan kam sotma', { kind: 'min', amount: 10000, currency: 'USD' }],
    ['Sell the car, do not go below $10,000', { kind: 'min', amount: 10000, currency: 'USD' }],
    ['Продай машину, не ниже 10000 долларов', { kind: 'min', amount: 10000, currency: 'USD' }],
    ["Mashinani 50 mln so'mdan arzon sotma", { kind: 'min', amount: 50_000_000, currency: 'UZS' }],
    ["Telefonni sotib ol, 300 dollardan ko'p to'lama", { kind: 'max', amount: 300, currency: 'USD' }],
    ['Buy it but pay no more than 5000 usd', { kind: 'max', amount: 5000, currency: 'USD' }],
  ])('%s', (text, want) => {
    expect(extractPriceLimits(text)).toEqual([want]);
  });
  it('no limit stated -> none', () => {
    expect(extractPriceLimits('Onix mashinamni sotmoqchiman, narx taklifini kut')).toEqual([]);
    expect(extractPriceLimits('Ertaga 15:00 yoki 17:00 uchrashuv')).toEqual([]);
  });
  it('encode / decode', () => {
    const l = { kind: 'min', amount: 10000, currency: 'USD' } as const;
    expect(decodeLimit(encodeLimit(l))).toEqual(l);
  });
  it('an offer below the floor is refused, at or above is fine, a foreign currency is not accepted blindly', () => {
    const limits = [{ kind: 'min', amount: 10000, currency: 'USD' }] as const;
    expect(checkOffer([...limits], 5000, 'USD')).toMatchObject({ acceptable: false, reason: 'below_floor' });
    expect(checkOffer([...limits], 9999, 'usd')).toMatchObject({ acceptable: false });
    expect(checkOffer([...limits], 10000, 'USD')).toMatchObject({ acceptable: true });
    expect(checkOffer([...limits], 12000, 'USD')).toMatchObject({ acceptable: true });
    expect(checkOffer([...limits], 100_000_000, 'UZS')).toMatchObject({ acceptable: false, reason: 'unknown_currency' });
    expect(checkOffer([...limits], 5000, '')).toMatchObject({ acceptable: false });
  });
  it('a ceiling refuses a higher price', () => {
    expect(checkOffer([{ kind: 'max', amount: 300, currency: 'USD' }], 350, 'USD')).toMatchObject({ acceptable: false, reason: 'above_ceiling' });
  });
});

import { relevance } from '../../apps/assistant/src/modules/messaging/intake.service.js';
describe('relevance', () => {
  it('matches the topic word through Uzbek suffixes', () => {
    expect(relevance('Javlon Onix uchun 5000 USD taklif qildi', 'Onixni qancha baholadi?')).toBeGreaterThan(0);
    expect(relevance('Ertaga 15:00 uchrashuv', 'Onixni qancha baholadi?')).toBe(0);
  });
});
