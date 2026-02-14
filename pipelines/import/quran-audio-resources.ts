/**
 * Quran Audio Source Registry
 *
 * Central registry defining reciters per source with URL builders.
 * No de-duplication — each source/reciter combination is a separate entry.
 *
 * Sources:
 * - EveryAyah.com (~70 folders) — per-ayah MP3s
 * - Al Quran Cloud CDN (27 editions) — per-ayah MP3s (sequential numbering)
 * - Quran Foundation (50+ reciters) — per-ayah MP3s
 */

import { prisma } from "../../src/db";
import { toSequentialAyah } from "../../src/utils/ayah-numbering";

// ============================================================================
// Types
// ============================================================================

export interface AudioSourceReciter {
  slug: string;           // "{source}/{name}": "everyayah/alafasy-128kbps"
  nameEnglish: string;
  nameArabic?: string;
  style?: string;         // "Murattal" | "Mujawwad" | "Muallim"
  qiraat?: string;        // "hafs" | "warsh"
  bitrate: number;
  language?: string;
  source: string;         // "everyayah" | "alquran-cloud" | "quran-foundation"
  sourceUrl: string;
  getAudioUrl: (surah: number, ayah: number) => string;
}

// ============================================================================
// Helpers
// ============================================================================

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function everyAyahUrl(folder: string) {
  return (surah: number, ayah: number) =>
    `https://everyayah.com/data/${folder}/${pad3(surah)}${pad3(ayah)}.mp3`;
}

function alquranCloudUrl(edition: string, bitrate: number) {
  return (surah: number, ayah: number) =>
    `https://cdn.islamic.network/quran/audio/${bitrate}/${edition}/${toSequentialAyah(surah, ayah)}.mp3`;
}

// ============================================================================
// EveryAyah.com Registry (~70 reciters)
// ============================================================================

const EVERYAYAH_RECITERS: AudioSourceReciter[] = [
  { slug: "everyayah/abdulsamad-64kbps", nameEnglish: "Abdul Samad", nameArabic: "عبدالباسط عبدالصمد", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("AbdulSamad_64kbps_QuranExplorer.Com") },
  { slug: "everyayah/abdulbasit-mujawwad-128kbps", nameEnglish: "Abdul Basit", nameArabic: "عبدالباسط عبدالصمد", style: "Mujawwad", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdul_Basit_Mujawwad_128kbps") },
  { slug: "everyayah/abdulbasit-murattal-192kbps", nameEnglish: "Abdul Basit", nameArabic: "عبدالباسط عبدالصمد", style: "Murattal", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdul_Basit_Murattal_192kbps") },
  { slug: "everyayah/abdulbasit-murattal-64kbps", nameEnglish: "Abdul Basit", nameArabic: "عبدالباسط عبدالصمد", style: "Murattal", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdul_Basit_Murattal_64kbps") },
  { slug: "everyayah/abdullaah-awwaad-al-juhaynee-128kbps", nameEnglish: "Abdullaah Awwaad Al-Juhaynee", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdullaah_3awwaad_Al-Juhaynee_128kbps") },
  { slug: "everyayah/abdullah-basfar-192kbps", nameEnglish: "Abdullah Basfar", nameArabic: "عبد الله بصفر", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdullah_Basfar_192kbps") },
  { slug: "everyayah/abdullah-basfar-32kbps", nameEnglish: "Abdullah Basfar", nameArabic: "عبد الله بصفر", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdullah_Basfar_32kbps") },
  { slug: "everyayah/abdullah-basfar-64kbps", nameEnglish: "Abdullah Basfar", nameArabic: "عبد الله بصفر", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdullah_Basfar_64kbps") },
  { slug: "everyayah/abdullah-matroud-128kbps", nameEnglish: "Abdullah Matroud", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdullah_Matroud_128kbps") },
  { slug: "everyayah/abdurrahmaan-as-sudais-192kbps", nameEnglish: "Abdurrahmaan As-Sudais", nameArabic: "عبدالرحمن السديس", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdurrahmaan_As-Sudais_192kbps") },
  { slug: "everyayah/abdurrahmaan-as-sudais-64kbps", nameEnglish: "Abdurrahmaan As-Sudais", nameArabic: "عبدالرحمن السديس", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abdurrahmaan_As-Sudais_64kbps") },
  { slug: "everyayah/abu-bakr-ash-shaatree-128kbps", nameEnglish: "Abu Bakr Ash-Shaatree", nameArabic: "أبو بكر الشاطري", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abu_Bakr_Ash-Shaatree_128kbps") },
  { slug: "everyayah/abu-bakr-ash-shaatree-64kbps", nameEnglish: "Abu Bakr Ash-Shaatree", nameArabic: "أبو بكر الشاطري", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Abu_Bakr_Ash-Shaatree_64kbps") },
  { slug: "everyayah/ahmed-neana-128kbps", nameEnglish: "Ahmed Neana", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ahmed_Neana_128kbps") },
  { slug: "everyayah/ahmed-ibn-ali-al-ajamy-128kbps", nameEnglish: "Ahmed ibn Ali al-Ajamy", nameArabic: "أحمد بن علي العجمي", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("ahmed_ibn_ali_al_ajamy_128kbps") },
  { slug: "everyayah/ahmed-ibn-ali-al-ajamy-128kbps-ketaballah", nameEnglish: "Ahmed ibn Ali al-Ajamy", nameArabic: "أحمد بن علي العجمي", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net") },
  { slug: "everyayah/ahmed-ibn-ali-al-ajamy-64kbps", nameEnglish: "Ahmed ibn Ali al-Ajamy", nameArabic: "أحمد بن علي العجمي", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ahmed_ibn_Ali_al-Ajamy_64kbps_QuranExplorer.Com") },
  { slug: "everyayah/akram-al-alaqimy-128kbps", nameEnglish: "Akram AlAlaqimy", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Akram_AlAlaqimy_128kbps") },
  { slug: "everyayah/alafasy-128kbps", nameEnglish: "Mishary Rashid Alafasy", nameArabic: "مشاري راشد العفاسي", style: "Murattal", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Alafasy_128kbps") },
  { slug: "everyayah/alafasy-64kbps", nameEnglish: "Mishary Rashid Alafasy", nameArabic: "مشاري راشد العفاسي", style: "Murattal", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Alafasy_64kbps") },
  { slug: "everyayah/ali-hajjaj-alsuesy-128kbps", nameEnglish: "Ali Hajjaj AlSuesy", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ali_Hajjaj_AlSuesy_128kbps") },
  { slug: "everyayah/ali-jaber-64kbps", nameEnglish: "Ali Jaber", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ali_Jaber_64kbps") },
  { slug: "everyayah/ayman-sowaid-64kbps", nameEnglish: "Ayman Sowaid", nameArabic: "أيمن سويد", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ayman_Sowaid_64kbps") },
  { slug: "everyayah/aziz-alili-128kbps", nameEnglish: "Aziz Alili", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("aziz_alili_128kbps") },
  { slug: "everyayah/fares-abbad-64kbps", nameEnglish: "Fares Abbad", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Fares_Abbad_64kbps") },
  { slug: "everyayah/ghamadi-40kbps", nameEnglish: "Saad Al-Ghamdi", nameArabic: "سعد الغامدي", bitrate: 40, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ghamadi_40kbps") },
  { slug: "everyayah/hani-rifai-192kbps", nameEnglish: "Hani Rifai", nameArabic: "هاني الرفاعي", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Hani_Rifai_192kbps") },
  { slug: "everyayah/hani-rifai-64kbps", nameEnglish: "Hani Rifai", nameArabic: "هاني الرفاعي", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Hani_Rifai_64kbps") },
  { slug: "everyayah/hudhaify-128kbps", nameEnglish: "Hudhaify", nameArabic: "علي بن عبدالرحمن الحذيفي", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Hudhaify_128kbps") },
  { slug: "everyayah/hudhaify-32kbps", nameEnglish: "Hudhaify", nameArabic: "علي بن عبدالرحمن الحذيفي", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Hudhaify_32kbps") },
  { slug: "everyayah/hudhaify-64kbps", nameEnglish: "Hudhaify", nameArabic: "علي بن عبدالرحمن الحذيفي", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Hudhaify_64kbps") },
  { slug: "everyayah/husary-128kbps", nameEnglish: "Husary", nameArabic: "محمود خليل الحصري", style: "Murattal", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Husary_128kbps") },
  { slug: "everyayah/husary-128kbps-mujawwad", nameEnglish: "Husary", nameArabic: "محمود خليل الحصري", style: "Mujawwad", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Husary_128kbps_Mujawwad") },
  { slug: "everyayah/husary-64kbps", nameEnglish: "Husary", nameArabic: "محمود خليل الحصري", style: "Murattal", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Husary_64kbps") },
  { slug: "everyayah/husary-muallim-128kbps", nameEnglish: "Husary (Muallim)", nameArabic: "محمود خليل الحصري", style: "Muallim", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Husary_Muallim_128kbps") },
  { slug: "everyayah/husary-mujawwad-64kbps", nameEnglish: "Husary", nameArabic: "محمود خليل الحصري", style: "Mujawwad", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Husary_Mujawwad_64kbps") },
  { slug: "everyayah/ibrahim-akhdar-32kbps", nameEnglish: "Ibrahim Akhdar", nameArabic: "إبراهيم الأخضر", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ibrahim_Akhdar_32kbps") },
  { slug: "everyayah/ibrahim-akhdar-64kbps", nameEnglish: "Ibrahim Akhdar", nameArabic: "إبراهيم الأخضر", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Ibrahim_Akhdar_64kbps") },
  { slug: "everyayah/karim-mansoori-40kbps", nameEnglish: "Karim Mansoori", bitrate: 40, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Karim_Mansoori_40kbps") },
  { slug: "everyayah/khaalid-abdullaah-al-qahtaanee-192kbps", nameEnglish: "Khaalid Abdullaah al-Qahtaanee", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Khaalid_Abdullaah_al-Qahtaanee_192kbps") },
  { slug: "everyayah/khalefa-al-tunaiji-64kbps", nameEnglish: "Khalefa Al-Tunaiji", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("khalefa_al_tunaiji_64kbps") },
  { slug: "everyayah/maher-almuaiqly-128kbps", nameEnglish: "Maher Al Muaiqly", nameArabic: "ماهر المعيقلي", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("MaherAlMuaiqly128kbps") },
  { slug: "everyayah/maher-almuaiqly-64kbps", nameEnglish: "Maher Al Muaiqly", nameArabic: "ماهر المعيقلي", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Maher_AlMuaiqly_64kbps") },
  { slug: "everyayah/mahmoud-ali-al-banna-32kbps", nameEnglish: "Mahmoud Ali Al-Banna", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("mahmoud_ali_al_banna_32kbps") },
  { slug: "everyayah/menshawi-16kbps", nameEnglish: "Menshawi", nameArabic: "محمد صديق المنشاوي", bitrate: 16, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Menshawi_16kbps") },
  { slug: "everyayah/menshawi-32kbps", nameEnglish: "Menshawi", nameArabic: "محمد صديق المنشاوي", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Menshawi_32kbps") },
  { slug: "everyayah/minshawy-mujawwad-192kbps", nameEnglish: "Minshawy", nameArabic: "محمد صديق المنشاوي", style: "Mujawwad", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Minshawy_Mujawwad_192kbps") },
  { slug: "everyayah/minshawy-mujawwad-64kbps", nameEnglish: "Minshawy", nameArabic: "محمد صديق المنشاوي", style: "Mujawwad", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Minshawy_Mujawwad_64kbps") },
  { slug: "everyayah/minshawy-murattal-128kbps", nameEnglish: "Minshawy", nameArabic: "محمد صديق المنشاوي", style: "Murattal", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Minshawy_Murattal_128kbps") },
  { slug: "everyayah/minshawy-teacher-128kbps", nameEnglish: "Minshawy (Teacher)", nameArabic: "محمد صديق المنشاوي", style: "Muallim", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Minshawy_Teacher_128kbps") },
  { slug: "everyayah/mohammad-al-tablaway-128kbps", nameEnglish: "Mohammad al-Tablaway", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Mohammad_al_Tablaway_128kbps") },
  { slug: "everyayah/mohammad-al-tablaway-64kbps", nameEnglish: "Mohammad al-Tablaway", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Mohammad_al_Tablaway_64kbps") },
  { slug: "everyayah/muhammad-abdulkareem-128kbps", nameEnglish: "Muhammad AbdulKareem", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_AbdulKareem_128kbps") },
  { slug: "everyayah/muhammad-ayyoub-128kbps", nameEnglish: "Muhammad Ayyoub", nameArabic: "محمد أيوب", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_Ayyoub_128kbps") },
  { slug: "everyayah/muhammad-ayyoub-32kbps", nameEnglish: "Muhammad Ayyoub", nameArabic: "محمد أيوب", bitrate: 32, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_Ayyoub_32kbps") },
  { slug: "everyayah/muhammad-ayyoub-64kbps", nameEnglish: "Muhammad Ayyoub", nameArabic: "محمد أيوب", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_Ayyoub_64kbps") },
  { slug: "everyayah/muhammad-jibreel-128kbps", nameEnglish: "Muhammad Jibreel", nameArabic: "محمد جبريل", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_Jibreel_128kbps") },
  { slug: "everyayah/muhammad-jibreel-64kbps", nameEnglish: "Muhammad Jibreel", nameArabic: "محمد جبريل", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhammad_Jibreel_64kbps") },
  { slug: "everyayah/muhsin-al-qasim-192kbps", nameEnglish: "Muhsin Al-Qasim", bitrate: 192, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Muhsin_Al_Qasim_192kbps") },
  { slug: "everyayah/mustafa-ismail-48kbps", nameEnglish: "Mustafa Ismail", bitrate: 48, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Mustafa_Ismail_48kbps") },
  { slug: "everyayah/nabil-rifa3i-48kbps", nameEnglish: "Nabil Rifa'i", bitrate: 48, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Nabil_Rifa3i_48kbps") },
  { slug: "everyayah/nasser-alqatami-128kbps", nameEnglish: "Nasser Alqatami", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Nasser_Alqatami_128kbps") },
  { slug: "everyayah/parhizgar-48kbps", nameEnglish: "Parhizgar", nameArabic: "شهریار پرهیزگار", bitrate: 48, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Parhizgar_48kbps") },
  { slug: "everyayah/sahl-yassin-128kbps", nameEnglish: "Sahl Yassin", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Sahl_Yassin_128kbps") },
  { slug: "everyayah/salaah-abdulrahman-bukhatir-128kbps", nameEnglish: "Salaah AbdulRahman Bukhatir", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Salaah_AbdulRahman_Bukhatir_128kbps") },
  { slug: "everyayah/salah-al-budair-128kbps", nameEnglish: "Salah Al-Budair", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Salah_Al_Budair_128kbps") },
  { slug: "everyayah/saood-ash-shuraym-128kbps", nameEnglish: "Saood ash-Shuraym", nameArabic: "سعود الشريم", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Saood_ash-Shuraym_128kbps") },
  { slug: "everyayah/saood-ash-shuraym-64kbps", nameEnglish: "Saood ash-Shuraym", nameArabic: "سعود الشريم", bitrate: 64, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Saood_ash-Shuraym_64kbps") },
  { slug: "everyayah/yaser-salamah-128kbps", nameEnglish: "Yaser Salamah", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Yaser_Salamah_128kbps") },
  { slug: "everyayah/yasser-ad-dussary-128kbps", nameEnglish: "Yasser Ad-Dussary", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("Yasser_Ad-Dussary_128kbps") },
  { slug: "everyayah/warsh", nameEnglish: "Warsh Reading", qiraat: "warsh", bitrate: 128, sourceUrl: "https://everyayah.com", source: "everyayah", getAudioUrl: everyAyahUrl("warsh") },
];

// ============================================================================
// Al Quran Cloud CDN (27 editions)
// Uses sequential numbering: 1-6236
// ============================================================================

// Hardcoded with highest available bitrate per edition (verified via HEAD checks).
// Excluded: ar.ibrahimakhbar (no files), ru.kuliev-audio-2 (no files)
const ALQURAN_CLOUD_RECITERS: AudioSourceReciter[] = [
  { slug: "alquran-cloud/ar.abdullahbasfar", nameEnglish: "Abdullah Basfar", nameArabic: "عبد الله بصفر", bitrate: 192, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/192/ar.abdullahbasfar", getAudioUrl: alquranCloudUrl("ar.abdullahbasfar", 192) },
  { slug: "alquran-cloud/ar.abdurrahmaansudais", nameEnglish: "Abdurrahmaan As-Sudais", nameArabic: "عبدالرحمن السديس", bitrate: 192, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/192/ar.abdurrahmaansudais", getAudioUrl: alquranCloudUrl("ar.abdurrahmaansudais", 192) },
  { slug: "alquran-cloud/ar.abdulsamad", nameEnglish: "Abdul Samad", nameArabic: "عبدالباسط عبدالصمد", bitrate: 64, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/64/ar.abdulsamad", getAudioUrl: alquranCloudUrl("ar.abdulsamad", 64) },
  { slug: "alquran-cloud/ar.shaatree", nameEnglish: "Abu Bakr Ash-Shaatree", nameArabic: "أبو بكر الشاطري", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.shaatree", getAudioUrl: alquranCloudUrl("ar.shaatree", 128) },
  { slug: "alquran-cloud/ar.ahmedajamy", nameEnglish: "Ahmed ibn Ali al-Ajamy", nameArabic: "أحمد بن علي العجمي", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.ahmedajamy", getAudioUrl: alquranCloudUrl("ar.ahmedajamy", 128) },
  { slug: "alquran-cloud/ar.alafasy", nameEnglish: "Alafasy", nameArabic: "مشاري العفاسي", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.alafasy", getAudioUrl: alquranCloudUrl("ar.alafasy", 128) },
  { slug: "alquran-cloud/ar.hanirifai", nameEnglish: "Hani Rifai", nameArabic: "هاني الرفاعي", bitrate: 192, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/192/ar.hanirifai", getAudioUrl: alquranCloudUrl("ar.hanirifai", 192) },
  { slug: "alquran-cloud/ar.husary", nameEnglish: "Husary", nameArabic: "محمود خليل الحصري", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.husary", getAudioUrl: alquranCloudUrl("ar.husary", 128) },
  { slug: "alquran-cloud/ar.husarymujawwad", nameEnglish: "Husary (Mujawwad)", nameArabic: "محمود خليل الحصري (المجود)", style: "Mujawwad", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.husarymujawwad", getAudioUrl: alquranCloudUrl("ar.husarymujawwad", 128) },
  { slug: "alquran-cloud/ar.hudhaify", nameEnglish: "Hudhaify", nameArabic: "علي بن عبدالرحمن الحذيفي", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.hudhaify", getAudioUrl: alquranCloudUrl("ar.hudhaify", 128) },
  { slug: "alquran-cloud/ar.mahermuaiqly", nameEnglish: "Maher Al Muaiqly", nameArabic: "ماهر المعيقلي", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.mahermuaiqly", getAudioUrl: alquranCloudUrl("ar.mahermuaiqly", 128) },
  { slug: "alquran-cloud/ar.muhammadayyoub", nameEnglish: "Muhammad Ayyoub", nameArabic: "محمد أيوب", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.muhammadayyoub", getAudioUrl: alquranCloudUrl("ar.muhammadayyoub", 128) },
  { slug: "alquran-cloud/ar.muhammadjibreel", nameEnglish: "Muhammad Jibreel", nameArabic: "محمد جبريل", bitrate: 128, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ar.muhammadjibreel", getAudioUrl: alquranCloudUrl("ar.muhammadjibreel", 128) },
  { slug: "alquran-cloud/ar.saoodshuraym", nameEnglish: "Saood bin Ibraaheem Ash-Shuraym", nameArabic: "سعود الشريم", bitrate: 64, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/64/ar.saoodshuraym", getAudioUrl: alquranCloudUrl("ar.saoodshuraym", 64) },
  { slug: "alquran-cloud/en.walk", nameEnglish: "Ibrahim Walk", bitrate: 192, language: "en", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/192/en.walk", getAudioUrl: alquranCloudUrl("en.walk", 192) },
  { slug: "alquran-cloud/ar.parhizgar", nameEnglish: "Parhizgar", nameArabic: "شهریار پرهیزگار", bitrate: 48, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/48/ar.parhizgar", getAudioUrl: alquranCloudUrl("ar.parhizgar", 48) },
  { slug: "alquran-cloud/ur.khan", nameEnglish: "Shamshad Ali Khan", bitrate: 64, language: "ur", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/64/ur.khan", getAudioUrl: alquranCloudUrl("ur.khan", 64) },
  { slug: "alquran-cloud/zh.chinese", nameEnglish: "Chinese", bitrate: 128, language: "zh", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/zh.chinese", getAudioUrl: alquranCloudUrl("zh.chinese", 128) },
  { slug: "alquran-cloud/fr.leclerc", nameEnglish: "Youssouf Leclerc", bitrate: 128, language: "fr", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/fr.leclerc", getAudioUrl: alquranCloudUrl("fr.leclerc", 128) },
  { slug: "alquran-cloud/ar.aymanswoaid", nameEnglish: "Ayman Sowaid", nameArabic: "أيمن سويد", bitrate: 64, language: "ar", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/64/ar.aymanswoaid", getAudioUrl: alquranCloudUrl("ar.aymanswoaid", 64) },
  { slug: "alquran-cloud/ru.kuliev-audio", nameEnglish: "Elmir Kuliev", bitrate: 128, language: "ru", source: "alquran-cloud", sourceUrl: "https://cdn.islamic.network/quran/audio/128/ru.kuliev-audio", getAudioUrl: alquranCloudUrl("ru.kuliev-audio", 128) },
];

// ============================================================================
// Quran Foundation (8 reciters on verses.quran.foundation CDN)
// Some reciters in their API redirect to EveryAyah mirrors — we skip those
// since we already have them from EveryAyah directly.
// ============================================================================

function quranFoundationUrl(cdnPath: string) {
  return (surah: number, ayah: number) =>
    `https://verses.quran.foundation/${cdnPath}/mp3/${pad3(surah)}${pad3(ayah)}.mp3`;
}

const QURAN_FOUNDATION_RECITERS: AudioSourceReciter[] = [
  { slug: "quran-foundation/abdulbaset-murattal", nameEnglish: "AbdulBaset AbdulSamad", nameArabic: "عبدالباسط عبدالصمد", style: "Murattal", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("AbdulBaset/Murattal") },
  { slug: "quran-foundation/abdulbaset-mujawwad", nameEnglish: "AbdulBaset AbdulSamad", nameArabic: "عبدالباسط عبدالصمد", style: "Mujawwad", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("AbdulBaset/Mujawwad") },
  { slug: "quran-foundation/sudais", nameEnglish: "Abdur-Rahman as-Sudais", nameArabic: "عبدالرحمن السديس", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Sudais") },
  { slug: "quran-foundation/shatri", nameEnglish: "Abu Bakr al-Shatri", nameArabic: "أبو بكر الشاطري", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Shatri") },
  { slug: "quran-foundation/rifai", nameEnglish: "Hani ar-Rifai", nameArabic: "هاني الرفاعي", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Rifai") },
  { slug: "quran-foundation/alafasy", nameEnglish: "Mishari Rashid al-Afasy", nameArabic: "مشاري راشد العفاسي", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Alafasy") },
  { slug: "quran-foundation/minshawi-murattal", nameEnglish: "Mohamed Siddiq al-Minshawi", nameArabic: "محمد صديق المنشاوي", style: "Murattal", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Minshawi/Murattal") },
  { slug: "quran-foundation/minshawi-mujawwad", nameEnglish: "Mohamed Siddiq al-Minshawi", nameArabic: "محمد صديق المنشاوي", style: "Mujawwad", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Minshawi/Mujawwad") },
  { slug: "quran-foundation/shuraym", nameEnglish: "Sa'ud ash-Shuraym", nameArabic: "سعود الشريم", bitrate: 192, source: "quran-foundation", sourceUrl: "https://quran.com", getAudioUrl: quranFoundationUrl("Shuraym") },
];

// ============================================================================
// Combined Registry
// ============================================================================

/**
 * Build the full reciter list from all sources.
 * All registries are hardcoded with verified URLs and highest available bitrates.
 */
export function buildAllReciters(): AudioSourceReciter[] {
  return [...EVERYAYAH_RECITERS, ...ALQURAN_CLOUD_RECITERS, ...QURAN_FOUNDATION_RECITERS];
}

/**
 * Sync all reciter metadata to the QuranReciter table.
 */
export async function syncReciterMetadata(reciters: AudioSourceReciter[]): Promise<number> {
  let synced = 0;
  for (const r of reciters) {
    await prisma.quranReciter.upsert({
      where: { slug: r.slug },
      update: {
        nameEnglish: r.nameEnglish,
        nameArabic: r.nameArabic || null,
        style: r.style || null,
        qiraat: r.qiraat || "hafs",
        bitrate: r.bitrate,
        source: r.source,
        sourceUrl: r.sourceUrl || null,
        language: r.language || "ar",
      },
      create: {
        slug: r.slug,
        nameEnglish: r.nameEnglish,
        nameArabic: r.nameArabic || null,
        style: r.style || null,
        qiraat: r.qiraat || "hafs",
        bitrate: r.bitrate,
        source: r.source,
        sourceUrl: r.sourceUrl || null,
        language: r.language || "ar",
      },
    });
    synced++;
  }
  return synced;
}

export { EVERYAYAH_RECITERS, ALQURAN_CLOUD_RECITERS, QURAN_FOUNDATION_RECITERS };
