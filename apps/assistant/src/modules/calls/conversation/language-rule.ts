/**
 * The spoken-language rule shared by every AI voice call. Live speech models drift into Hindi, German, Turkish and other languages when
 * the line is noisy or the Uzbek is not recognised; this pins the default and says exactly when a switch is allowed.
 */
export const VOICE_LANGUAGE_RULE =
  "SUHBAT TILI: DOIM O'ZBEK TILIDA (lotin talaffuzida, oddiy so'zlashuv uslubida) gapir. " +
  "Faqat suhbatdosh o'zi ketma-ket TO'LIQ jumlalarni aniq RUS yoki INGLIZ tilida gapirsa, shu tilga o't (va u o'zbekchaga qaytsa, sen ham qayt). " +
  'BOSHQA HECH QANDAY TILDA gapirma: hind, nemis, turk, arab, ispan, fransuz, xitoy va boshqa tillarda mutlaqo gapirma. ' +
  "Agar gap tushunarsiz, shovqinli yoki boshqa tilga o'xshab eshitilsa, buni o'zbekcha deb hisobla va o'zbekcha ayt: \"Kechirasiz, eshitolmadim, takrorlab bera olasizmi?\". " +
  "Raqam, vaqt va ismlarni ham o'zbekcha ayt.";
