'use strict';

// Keep script joiners inside words, emoji sequences, and variation selectors intact.
const formatting = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u061C]/gu;
const isolatedNonJoiner = /(?<![\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Sinhala}\p{Mark}])\u200C(?![\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Sinhala}\p{Mark}])/gu;
const controls = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u;
const literalFormat = /(?<!\\)(?:\\u(?:200[b-f]|202[a-e]|206[0-9a-f]|feff|061c)|_x(?:200[b-f]|202[a-e]|206[0-9a-f]|feff|061c)_)/giu;

function repairText(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  // A replacement character or a byte control embedded in text is ambiguous.
  // Removing it would hide evidence that decoding or content must be checked.
  if (/[\uFFFD\uD800-\uDFFF\uFFFE\uFFFF]/u.test(raw) || controls.test(raw) || /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[€\u0080-\u00BF])/u.test(raw)) {
    return { value: null, needsReview: true };
  }
  const text = raw.replace(literalFormat, token => String.fromCodePoint(parseInt(token.slice(2, 6), 16)))
    .replace(formatting, '').replace(isolatedNonJoiner, '')
    .replace(/^(?:[\t\u00A0\u202F \u3000])+|(?:[\t\u00A0\u202F \u3000])+$/gu, '');
  if (text === raw || (text === '' && raw.trim() === '' && !/[\t\u00A0\u202F\u3000]/u.test(raw))) return null;
  return { value: text, needsReview: false };
}

function repairFields(fields) {
  const repairs = {};
  for (const [key, value] of Object.entries(fields)) {
    const repair = repairText(value);
    if (repair) repairs[key] = repair;
  }
  return repairs;
}

module.exports = { repairText, repairFields };
