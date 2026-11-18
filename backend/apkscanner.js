/**
 * apkScanner.js  –  Android APK intelligent analyser
 *
 * HOW IT WORKS:
 *  1. Opens the APK as a ZIP archive (APKs are ZIP files)
 *  2. Extracts binary signals: package name, activities, permissions,
 *     deep-link schemes, string resources, DEX string pool
 *  3. Builds the same merged-signals shape as scanner.js
 *  4. Feeds signals to AI with mobile-specific prompt
 *  5. Returns identical result shape → same frontend renders everything
 *
 * NO system dependencies needed (no apktool, no Java).
 * Pure Node.js using adm-zip for ZIP extraction.
 */

'use strict';

const AdmZip = require('adm-zip');
const https  = require('https');
const path   = require('path');

const { store: trainingStore } = require('./training/store');

// ─── Extract readable ASCII strings from a binary buffer ─────────────────────
function extractPrintableStrings(buffer, minLen = 5) {
  const results = new Set();
  let current   = '';
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c >= 32 && c < 127) {
      current += String.fromCharCode(c);
    } else {
      if (current.length >= minLen) results.add(current.trim());
      current = '';
    }
  }
  if (current.length >= minLen) results.add(current.trim());
  return [...results].filter(s => s.length >= minLen);
}

// ─── Extract UTF-16 LE strings (common in Android binary XML) ────────────────
function extractUtf16Strings(buffer, minLen = 4) {
  const results = new Set();
  let current   = '';
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const lo = buffer[i], hi = buffer[i + 1];
    if (hi === 0 && lo >= 32 && lo < 127) {
      current += String.fromCharCode(lo);
    } else {
      if (current.length >= minLen) results.add(current.trim());
      current = '';
    }
  }
  if (current.length >= minLen) results.add(current.trim());
  return [...results].filter(s => s.length >= minLen);
}

// ─── DEX string-table parser ─────────────────────────────────────────────────
// classes.dex stores every string the app references in a clean, indexed
// string table — far better than byte-scraping (which mixes in cert chains,
// bytecode debris, and encoded blobs). The DEX header at offset 0 gives:
//   • string_ids_size @ 0x38 (56)  — number of strings
//   • string_ids_off  @ 0x3C (60)  — offset to the string_id table
// Each string_id is a 4-byte offset to a string_data_item: a ULEB128 char
// count followed by MUTF-8 bytes, null-terminated. We skip the ULEB128 and
// read the bytes up to the null. MUTF-8 decodes as UTF-8 for all the ASCII/
// BMP text we care about (class names, URLs, UI labels, SDK package names).
//
// Class descriptors come through in JVM form ("Lcom/acme/ProductActivity;");
// we also emit a dotted form ("com.acme.ProductActivity") so the existing
// activity/service/screen-name heuristics in classifyApkStrings pick them up.
// Returns [] on any header/bounds problem — caller falls back to byte-scrape.
function parseDexStrings(buf, { maxStrings = 80000, minLen = 3 } = {}) {
  if (!buf || buf.length < 112) return [];
  // magic: "dex\n" = 0x64 0x65 0x78 0x0a
  if (buf[0] !== 0x64 || buf[1] !== 0x65 || buf[2] !== 0x78 || buf[3] !== 0x0a) return [];
  const stringIdsSize = buf.readUInt32LE(56);
  const stringIdsOff  = buf.readUInt32LE(60);
  if (!stringIdsSize || stringIdsOff + stringIdsSize * 4 > buf.length) return [];

  const out   = [];
  const limit = Math.min(stringIdsSize, maxStrings);
  for (let i = 0; i < limit; i++) {
    const dataOff = buf.readUInt32LE(stringIdsOff + i * 4);
    if (dataOff <= 0 || dataOff >= buf.length) continue;
    // Skip the ULEB128 utf16 length prefix.
    let pos = dataOff, b;
    do { b = buf[pos++]; } while ((b & 0x80) && pos < buf.length);
    // Read MUTF-8 bytes up to the null terminator.
    let end = pos;
    while (end < buf.length && buf[end] !== 0) end++;
    if (end - pos < minLen) continue;
    const s = buf.toString('utf8', pos, end);
    out.push(s);
    // Emit a dotted form for JVM class descriptors so downstream regexes match.
    if (s.length > 2 && s.charCodeAt(0) === 76 /* 'L' */ && s.charCodeAt(s.length - 1) === 59 /* ';' */
        && s.indexOf('/') !== -1) {
      out.push(s.slice(1, -1).replace(/\//g, '.'));
    }
  }
  return out;
}

// ─── Package-name blacklist ──────────────────────────────────────────────────
// String-scraping DEX files surfaces every package referenced by the app,
// including framework/SDK packages. When we have to fall back from the AXML
// parser (i.e. real manifest is unavailable), we use this list to filter out
// non-app-package candidates so we don't pick `java.vm.name` or `androidx.x.y`
// as the app's own package.
const PKG_BLACKLIST_PREFIXES = [
  'java.', 'javax.', 'kotlin', 'kotlinx',
  'androidx.', 'android.support.', 'android.arch.', 'android.os.',
  'android.util.', 'android.text.', 'android.app.', 'android.view.',
  'android.content.', 'android.media.', 'android.net.',
  'org.jetbrains.', 'org.intellij.',
  'com.google.android.gms', 'com.google.android.material',
  'com.google.firebase', 'com.google.protobuf', 'com.google.gson',
  'com.squareup.', 'com.bumptech.glide', 'com.facebook.shimmer',
  'dalvik.', 'sun.', 'com.android.', 'okhttp3.', 'okio.', 'retrofit2.',
];
function isJunkPackageCandidate(s) {
  return PKG_BLACKLIST_PREFIXES.some(p => s.startsWith(p));
}

// ─── AXML (Android binary XML) manifest parser ───────────────────────────────
// AndroidManifest.xml inside an APK is binary AXML, NOT plain XML. Naïve
// string-scraping picks up garbage (system constants leak in, the real package
// name is hidden among hundreds of references). This parser walks the chunked
// AXML format and returns AUTHORITATIVE values for:
//   • package name (from <manifest package="...">)
//   • permissions (from <uses-permission>)
//   • activities / services / receivers / providers (real declared classes)
//   • deep-link schemes (from <data android:scheme="..."> inside intent-filter)
//
// Returns null on any parse failure — callers fall back to string scraping.
// Format reference: AOSP frameworks/base/include/androidfw/ResourceTypes.h
function parseAxmlStringPool(buf, chunkOff) {
  const stringCount  = buf.readUInt32LE(chunkOff + 8);
  const flags        = buf.readUInt32LE(chunkOff + 16);
  const stringsStart = buf.readUInt32LE(chunkOff + 20);
  const isUtf8       = (flags & 0x100) !== 0;
  const strings      = new Array(stringCount);
  const baseOff      = chunkOff + stringsStart;
  for (let i = 0; i < stringCount; i++) {
    const so = buf.readUInt32LE(chunkOff + 28 + i * 4);
    let pos = baseOff + so;
    if (pos < 0 || pos >= buf.length) { strings[i] = ''; continue; }
    try {
      if (isUtf8) {
        let l1 = buf[pos++]; if (l1 & 0x80) { pos++; }                              // skip utf16 char length
        let l2 = buf[pos++]; if (l2 & 0x80) { l2 = ((l2 & 0x7F) << 8) | buf[pos++]; } // utf8 byte length
        strings[i] = buf.toString('utf8', pos, pos + l2);
      } else {
        let len = buf.readUInt16LE(pos); pos += 2;
        if (len & 0x8000) { len = ((len & 0x7FFF) << 16) | buf.readUInt16LE(pos); pos += 2; }
        strings[i] = buf.toString('utf16le', pos, pos + len * 2);
      }
    } catch (_) { strings[i] = ''; }
  }
  return strings;
}

function resolveAxmlClassName(name, packageName) {
  if (!name) return '';
  if (name.startsWith('.')) return packageName + name;
  if (!name.includes('.') && packageName) return packageName + '.' + name;
  return name;
}

function parseAxmlManifest(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf.readUInt16LE(0) !== 0x0003) return null;   // RES_XML_TYPE
  const fileHeaderSize = buf.readUInt16LE(2);

  const RES_STRING_POOL = 0x0001;
  const RES_XML_START   = 0x0102;

  let off = fileHeaderSize;
  let strings = null;
  const result = {
    packageName:     '',
    permissions:     [],
    activities:      [],
    services:        [],
    receivers:       [],
    providers:       [],
    deepLinkSchemes: [],
    appLabelRaw:     '',
  };

  while (off + 8 <= buf.length) {
    const chunkType  = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const chunkSize  = buf.readUInt32LE(off + 4);
    if (chunkSize <= 0 || off + chunkSize > buf.length) break;

    if (chunkType === RES_STRING_POOL && !strings) {
      try { strings = parseAxmlStringPool(buf, off); } catch (_) { return null; }
    } else if (chunkType === RES_XML_START && strings) {
      try {
        const nameIdx   = buf.readUInt32LE(off + headerSize + 4);
        const attrStart = buf.readUInt16LE(off + headerSize + 8);
        const attrCount = buf.readUInt16LE(off + headerSize + 12);
        const tagName   = strings[nameIdx] || '';
        const attrBase  = off + headerSize + attrStart;
        const attrs = {};
        for (let i = 0; i < attrCount; i++) {
          const aOff = attrBase + i * 20;
          if (aOff + 20 > buf.length) break;
          const aName  = buf.readUInt32LE(aOff + 4);
          const aRaw   = buf.readUInt32LE(aOff + 8);
          const tvType = buf.readUInt8(aOff + 15);
          const tvData = buf.readUInt32LE(aOff + 16);
          const attrName = strings[aName] || '';
          let value;
          if (aRaw !== 0xFFFFFFFF) {
            value = strings[aRaw] || '';
          } else if (tvType === 0x03) {                  // TYPE_STRING
            value = strings[tvData] || '';
          } else if (tvType === 0x01) {                  // TYPE_REFERENCE — resource ref
            value = '@' + tvData.toString(16);
          } else if (tvType === 0x12) {                  // TYPE_INT_BOOLEAN
            value = tvData !== 0;
          } else {
            value = String(tvData);
          }
          attrs[attrName] = value;
        }

        if (tagName === 'manifest' && typeof attrs.package === 'string') {
          result.packageName = attrs.package;
        } else if (tagName === 'uses-permission' && typeof attrs.name === 'string') {
          result.permissions.push(attrs.name.replace(/^android\.permission\./, ''));
        } else if (tagName === 'activity' && typeof attrs.name === 'string') {
          result.activities.push(resolveAxmlClassName(attrs.name, result.packageName));
        } else if (tagName === 'service' && typeof attrs.name === 'string') {
          result.services.push(resolveAxmlClassName(attrs.name, result.packageName));
        } else if (tagName === 'receiver' && typeof attrs.name === 'string') {
          result.receivers.push(resolveAxmlClassName(attrs.name, result.packageName));
        } else if (tagName === 'provider' && typeof attrs.name === 'string') {
          result.providers.push(resolveAxmlClassName(attrs.name, result.packageName));
        } else if (tagName === 'application' && typeof attrs.label === 'string') {
          result.appLabelRaw = attrs.label;
        } else if (tagName === 'data' && typeof attrs.scheme === 'string' && attrs.scheme) {
          // Custom URI schemes inside intent-filter — exclude http/https/android
          if (!/^https?$/i.test(attrs.scheme) && !/^android/i.test(attrs.scheme) && attrs.scheme.length < 30) {
            result.deepLinkSchemes.push(attrs.scheme + '://');
          }
        }
      } catch (_) { /* tolerate per-element parse errors */ }
    }

    off += chunkSize;
  }

  if (!result.packageName) return null;        // Sanity: a manifest without a package is unusable.

  result.permissions     = [...new Set(result.permissions)];
  result.activities      = [...new Set(result.activities)];
  result.services        = [...new Set(result.services)];
  result.receivers       = [...new Set(result.receivers)];
  result.providers       = [...new Set(result.providers)];
  result.deepLinkSchemes = [...new Set(result.deepLinkSchemes)];
  return result;
}

// ─── Parse only the string pool from any AXML file ───────────────────────────
// res/layout/*.xml and res/values*/strings.xml use the same chunked AXML
// format as AndroidManifest.xml. The string pool (always the first chunk
// after the file header) contains every literal string in the file — tag
// names, attribute names, attribute values, and the actual UI text. We use
// this in extractLayoutLabels() to mine compiled layouts and strings.xml for
// user-facing widget labels without walking the full element tree.
function parseAxmlFileStrings(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf.readUInt16LE(0) !== 0x0003) return null;
  const fileHeaderSize = buf.readUInt16LE(2);
  let off = fileHeaderSize;
  while (off + 8 <= buf.length) {
    const chunkType = buf.readUInt16LE(off);
    const chunkSize = buf.readUInt32LE(off + 4);
    if (chunkSize <= 0 || off + chunkSize > buf.length) break;
    if (chunkType === 0x0001) {                           // RES_STRING_POOL
      try { return parseAxmlStringPool(buf, off); } catch (_) { return null; }
    }
    off += chunkSize;
  }
  return null;
}

// ─── Layout-label extractor (res/layout + res/values/strings.xml) ────────────
// In compiled APKs, the user-facing button labels, screen titles, EditText
// hints, and TextView text values live in:
//   • res/layout*/*.xml         — widget hierarchies (Buttons, EditText, etc.)
//   • res/values*/strings.xml   — <string name="...">value</string> entries
//   • other res/values*/*.xml   — colors / dimens / styles (less useful but
//                                  scanned for completeness)
// All three are compiled AXML. We dump each one's string pool, then filter
// out the structural noise (tag names, attribute names, layout constants)
// to keep just the labels and resource names. This is the highest-quality
// vertical signal available in an obfuscated APK because layout XML is the
// part that ProGuard does NOT obfuscate.
const LAYOUT_LABEL_DENYLIST = new Set([
  // structural / element / attribute / constant tokens
  'resources', 'string', 'string-array', 'plurals', 'item', 'array', 'integer', 'bool', 'color', 'dimen', 'style', 'styleable', 'attr', 'declare-styleable',
  'name', 'translatable', 'formatted', 'parent', 'type',
  'android', 'app', 'tools', 'merge', 'include',
  // common element types
  'View', 'ViewGroup', 'ViewStub', 'LinearLayout', 'RelativeLayout', 'FrameLayout', 'ConstraintLayout', 'CoordinatorLayout', 'AppBarLayout', 'CollapsingToolbarLayout', 'Toolbar', 'DrawerLayout', 'Spinner', 'CheckBox', 'CheckedTextView', 'RadioButton', 'RadioGroup', 'TextView', 'EditText', 'Button', 'ImageView', 'ImageButton', 'Switch', 'Slider', 'ProgressBar', 'WebView', 'ScrollView', 'NestedScrollView', 'HorizontalScrollView', 'TabLayout', 'TabItem', 'TextInputLayout', 'TextInputEditText', 'AutoCompleteTextView', 'MaterialButton', 'MaterialCardView', 'CardView', 'RecyclerView', 'ListView', 'GridView', 'GridLayout', 'BottomNavigationView', 'NavigationView', 'FloatingActionButton', 'Space', 'Chip', 'ChipGroup', 'Guideline', 'Barrier',
  // common attribute names (local name, no namespace prefix)
  'layout_width', 'layout_height', 'layout_margin', 'layout_marginStart', 'layout_marginEnd', 'layout_marginTop', 'layout_marginBottom', 'layout_marginLeft', 'layout_marginRight', 'layout_gravity', 'layout_weight', 'layout_centerInParent', 'layout_centerHorizontal', 'layout_centerVertical', 'background', 'backgroundTint', 'gravity', 'padding', 'paddingLeft', 'paddingRight', 'paddingStart', 'paddingEnd', 'paddingTop', 'paddingBottom', 'visibility', 'orientation', 'src', 'srcCompat', 'text', 'hint', 'textSize', 'textColor', 'textStyle', 'textAlignment', 'textAppearance', 'inputType', 'maxLength', 'maxLines', 'minLines', 'singleLine', 'ellipsize', 'fontFamily', 'typeface', 'contentDescription', 'id', 'tag', 'clickable', 'focusable', 'enabled', 'checkable', 'checked', 'tint', 'tintMode', 'cardElevation', 'cardCornerRadius', 'rippleColor', 'icon', 'iconTint', 'iconGravity', 'iconSize', 'menu', 'theme',
  // common constant values
  'match_parent', 'wrap_content', 'fill_parent', 'center', 'center_horizontal', 'center_vertical', 'top', 'bottom', 'left', 'right', 'start', 'end', 'horizontal', 'vertical', 'visible', 'invisible', 'gone', 'true', 'false', 'none', 'normal', 'bold', 'italic', 'sans-serif', 'sans-serif-medium', 'roboto', 'monospace',
  // namespace URIs
  'http://schemas.android.com/apk/res/android',
  'http://schemas.android.com/apk/res-auto',
  'http://schemas.android.com/tools',
]);

// ─── Shared per-string label filter ─────────────────────────────────────────
// Decides whether an extracted string looks like a real user-facing label.
// Used by both extractLayoutLabels (AXML files) and extractArscLabels
// (binary resource table) so identical filter rules apply to both sources.
function acceptLabelCandidate(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.length < 3 || raw.length > 200) return false;
  const s = raw.trim();
  if (LAYOUT_LABEL_DENYLIST.has(s)) return false;
  if (s.startsWith('@'))    return false;     // unresolved resource ref
  if (s.startsWith('http')) return false;     // namespace URI
  if (s.includes('/'))      return false;     // path / URI
  if (s.startsWith('?'))    return false;     // theme attr ref like ?attr/colorPrimary
  if (/^#[0-9a-fA-F]+$/.test(s))                              return false; // hex color
  if (/^-?\d+(?:\.\d+)?(?:dp|sp|px|dip|pt|in|mm)$/i.test(s))  return false; // dimension
  if (/^-?\d+$/.test(s))                                      return false; // integer
  if (/^[A-Z][a-zA-Z]*\$[a-zA-Z]/.test(s))                    return false; // inner class refs

  const hasWordRun       = /[A-Za-z]{3,}/.test(s);
  const hasSpace         = s.includes(' ');
  const isSnakeCaseName  = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}$/.test(s);
  const isTitleMultiCase = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(s);

  const isFrameworkResName = isSnakeCaseName && (
    /^(?:abc|mtrl|m3|material|androidx|appcompat|design|coord|coordinator|fab|tab|nav|dialog|snack|tooltip|ripple|checkbox|radiobutton|switch|slider|progress|picker|btn|ic|bg|ico|fg|theme|color|dim|size|state|anim|attr|style|layout|view|viewpager|recycler|list|grid|scroll|drawer|toolbar|appbar|divider|edittext|textinput|textview|imageview|button|card|item|row|cell|group|badge|chip|spinner|autocomplete|header|footer|menu|popup|banner|overlay|mask|shadow|elevation|corner|radius|padding|margin|border|outline|dot|ring|box|path|vector|drawable|selector|shape|gradient|clip|transform|transition|animation|fade|slide|motion|tween|frame|container|guided|guidedstep|guidedactions|gestures|leanback|inapp|ct_|fb_|firebase|gms|google|gtm|crashlytics|com_facebook|adjust|amplitude|braze|segment|mixpanel|appsflyer|onesignal|exo|exoplayer|media3|legacy|abc_|androidx_)_/i.test(s)
    || /(?:_merged|_dilate|_path|_outline|_clip|_stroke|_fill|_morph|_null|_inner|_outer|_focused|_pressed|_selected|_activated|_checked|_hovered|_disabled|_unchecked|_enabled|_window_focused|_referenced_ids)$/i.test(s)
  );

  return hasWordRun && !isFrameworkResName && (hasSpace || isTitleMultiCase) && !isSnakeCaseName;
}

function extractLayoutLabels(entries, { fileLimit = 800, labelLimit = 400 } = {}) {
  // Match ANY XML under res/. AAPT2 resource-path shortening (enabled by R8
  // for release builds) renames res/layout/foo.xml → res/-B.xml, so we can
  // no longer rely on the original directory name.
  const targetRe = /^res\/[^/]*\.xml$|^res\/[^/]+\/[^/]+\.xml$/i;
  const pool = new Set();
  let filesScanned = 0;
  let filesWithLabels = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!targetRe.test(entry.entryName)) continue;
    if (filesScanned >= fileLimit) break;
    filesScanned++;

    let strs;
    try { strs = parseAxmlFileStrings(entry.getData()); } catch (_) { continue; }
    if (!strs) continue;

    let added = 0;
    for (const s of strs) {
      if (pool.size >= labelLimit) break;
      if (acceptLabelCandidate(s)) { pool.add(s.trim()); added++; }
    }
    if (added > 0) filesWithLabels++;
    if (pool.size >= labelLimit) break;
  }

  console.log(`[APK] Layout/XML scan: ${filesScanned} files (${filesWithLabels} with labels) → ${pool.size} candidate labels`);
  return [...pool];
}

// ─── Parse resources.arsc and dump every RES_STRING_POOL chunk it contains ──
// resources.arsc is the compiled binary resource table. It holds:
//   • a top-level RES_TABLE chunk (0x0002) that wraps everything
//   • a global RES_STRING_POOL (0x0001) — this is the GOLD MINE: contains
//     every actual string VALUE the app declares (e.g. "Reserve a Table",
//     "Pump number", "Order Now") that any @string/foo reference resolves to.
//   • one or more RES_TABLE_PACKAGE chunks (0x0200) that themselves contain
//     more string pools (type names "string"/"drawable" and key names like
//     "restaurant_name") plus the resource type tables.
// We don't need to walk the type tables — we only need the string contents.
// So we recursively descend into RES_TABLE and RES_TABLE_PACKAGE chunks and
// collect every nested RES_STRING_POOL.
//
// This is what byte-scraping resources.arsc could never give cleanly: the
// real declared resource values, not cert chains and Dalvik debris.
function extractArscLabels(buf, { labelLimit = 600, maxStrings = 50000 } = {}) {
  if (!buf || buf.length < 12) return [];
  // RES_TABLE_TYPE header at offset 0
  if (buf.readUInt16LE(0) !== 0x0002) return [];

  const pool = new Set();
  let totalRaw = 0;

  function visitStringPool(off) {
    try {
      const strs = parseAxmlStringPool(buf, off);
      if (!strs) return;
      for (const s of strs) {
        if (totalRaw >= maxStrings) return;
        totalRaw++;
        if (pool.size >= labelLimit) return;
        if (acceptLabelCandidate(s)) pool.add(s.trim());
      }
    } catch (_) { /* tolerate per-pool parse errors */ }
  }

  function walk(off, end) {
    while (off + 8 <= end) {
      const chunkType  = buf.readUInt16LE(off);
      const headerSize = buf.readUInt16LE(off + 2);
      const chunkSize  = buf.readUInt32LE(off + 4);
      if (chunkSize <= 0 || off + chunkSize > end) return;
      if (chunkType === 0x0001) {                               // RES_STRING_POOL
        visitStringPool(off);
      } else if (chunkType === 0x0002 || chunkType === 0x0200) {
        // RES_TABLE or RES_TABLE_PACKAGE — descend into payload after the header
        walk(off + headerSize, off + chunkSize);
      }
      if (pool.size >= labelLimit) return;
      off += chunkSize;
    }
  }

  walk(0, buf.length);
  console.log(`[APK] resources.arsc scan: ${totalRaw} raw strings → ${pool.size} candidate labels`);
  return [...pool];
}

// ─── Vertical-revealing vocabulary (used for label prioritisation) ──────────
// When we extract 500+ candidate labels but only have budget to send ~150 to
// the LLM, we sort them so the most vertical-revealing strings appear first.
// A label scores 1 point per keyword it contains; labels with score > 0 are
// pinned ahead of unscored labels (which retain their original order).
//
// This is the difference between sending the LLM "Restaurant Viewed", "Add to
// Cart", "Order Now" in slots 12-14 (vs. them sitting in slots 320-322 below
// the cap) — and that determines whether a food-delivery app gets classified
// as FOOD or as "social messaging because I saw Facebook auth + CT Inbox".
const VERTICAL_KEYWORDS = {
  food:        ['restaurant', 'cuisine', 'menu', 'dish', 'cart', 'order', 'delivery', 'reservation', 'table', 'kitchen', 'chef', 'recipe', 'meal', 'breakfast', 'lunch', 'dinner', 'snack', 'beverage', 'cuisine', 'add to cart', 'checkout', 'place order', 'track order', 'cooking', 'food'],
  rideshare:   ['ride', 'driver', 'vehicle', 'pickup', 'drop', 'fare', 'rider', 'cab', 'taxi', 'car wash', 'fuel', 'petrol', 'diesel', 'tyre', 'tire', 'rental', 'mileage', 'plate'],
  travel:      ['flight', 'hotel', 'booking', 'itinerary', 'trip', 'destination', 'stay', 'check-in', 'check-out', 'guest', 'baggage', 'boarding', 'reservation', 'travel'],
  ecommerce:   ['product', 'cart', 'wishlist', 'checkout', 'discount', 'coupon', 'add to cart', 'place order', 'shipping', 'return', 'review', 'rating', 'price', 'sale', 'shop', 'store', 'catalog'],
  fintech:     ['account', 'transfer', 'send money', 'beneficiary', 'kyc', 'upi', 'ifsc', 'pan', 'aadhaar', 'mutual fund', 'portfolio', 'sip', 'fd', 'rd', 'crypto', 'wallet', 'loan', 'credit', 'debit', 'emi', 'statement', 'interest rate'],
  health:      ['doctor', 'patient', 'prescription', 'appointment', 'pharmacy', 'consult', 'medicine', 'symptom', 'diagnosis', 'lab test', 'health record'],
  fitness:     ['workout', 'exercise', 'calorie', 'steps', 'cardio', 'strength', 'goal', 'activity', 'pace', 'rest day', 'fitness'],
  edu:         ['lesson', 'course', 'quiz', 'exam', 'tutor', 'classroom', 'assignment', 'homework', 'learn', 'syllabus', 'grade'],
  social:      ['feed', 'reel', 'story', 'post', 'follower', 'following', 'hashtag', 'mention', 'comment', 'reaction', 'profile'],
  messaging:   ['chat', 'message', 'conversation', 'inbox', 'thread', 'reply', 'typing', 'last seen'],
  content:     ['video', 'episode', 'season', 'series', 'movie', 'podcast', 'article', 'channel', 'stream', 'subscribe', 'playlist', 'watch later'],
  dating:      ['swipe', 'match', 'super like', 'compatibility', 'date'],
  gaming:      ['level', 'achievement', 'reward', 'score', 'xp', 'unlock', 'leaderboard', 'tournament', 'mission', 'quest', 'gem', 'coin'],
  productivity:['document', 'workspace', 'collaborator', 'task', 'board', 'project', 'note', 'invite', 'share'],
};

// ─── Cross-platform framework detection ─────────────────────────────────────
// Flutter / React Native / Capacitor / Cordova / Unity / Xamarin apps compile
// most of their UI text into native binaries (libapp.so for Flutter, JS
// bundles for RN, etc.) which our AXML / resources.arsc parsers cannot read.
// Detecting the framework lets us:
//   1. Surface a clear warning to the caller / UI.
//   2. Mine the asset-filename signals (extractAssetFilenameSignals below) —
//      for cross-platform apps these are often the *only* vertical-revealing
//      data we can extract.
function detectFramework(entries) {
  const has = (re) => entries.some((e) => !e.isDirectory && re.test(e.entryName));
  if (has(/^lib\/[^/]+\/libflutter\.so$/i) || has(/^assets\/flutter_assets\//i)) {
    return { kind: 'flutter', label: 'Flutter (Dart AOT)' };
  }
  if (has(/^assets\/index\.android\.bundle$/i) || has(/^lib\/[^/]+\/libhermes\.so$/i) || has(/^lib\/[^/]+\/libreactnativejni\.so$/i)) {
    return { kind: 'react-native', label: 'React Native' };
  }
  if (has(/^assets\/capacitor\.config/i) || has(/^assets\/public\/.+\.html$/i)) {
    return { kind: 'capacitor', label: 'Capacitor / Ionic' };
  }
  if (has(/^assets\/www\/index\.html$/i) || has(/^assets\/www\/cordova\.js$/i)) {
    return { kind: 'cordova', label: 'Cordova / PhoneGap' };
  }
  if (has(/^lib\/[^/]+\/libunity\.so$/i) || has(/^assets\/bin\/Data\//i)) {
    return { kind: 'unity', label: 'Unity' };
  }
  if (has(/^lib\/[^/]+\/libmonodroid\.so$/i) || has(/^lib\/[^/]+\/libxamarin/i)) {
    return { kind: 'xamarin', label: 'Xamarin / .NET' };
  }
  return { kind: 'native', label: 'Native Android' };
}

// ─── Mine vertical-revealing signals from asset filenames ────────────────────
// For cross-platform apps the asset PNG/GIF/JSON basenames are often the
// strongest extractable signal. A Flutter food-delivery app might ship
// Resto.png / Moto.png / cart_gif.gif / menu_card.png — those basenames are
// vertical-revealing on their own.
function extractAssetFilenameSignals(entries, { limit = 120 } = {}) {
  const targetRe = /^(?:assets|res)\/.+\.(?:png|jpg|jpeg|webp|gif|svg|json|html|js)$/i;
  const pool = new Set();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!targetRe.test(entry.entryName)) continue;
    // Take the basename without extension, ignore depth.
    const base = entry.entryName.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    if (!base || base.length < 3 || base.length > 60) continue;
    // Skip pure-number / single-char framework names like "1.png", "a.svg",
    // and Material/AndroidX widget IDs ("abc_btn_check_material").
    if (/^[a-z0-9]{1,3}$/i.test(base)) continue;
    if (/^(?:abc|mtrl|m3|material|androidx|appcompat)_/i.test(base)) continue;
    if (/^\d+x\d+$/.test(base)) continue;
    // Humanise: snake_case / kebab-case → space-separated, preserve
    // PascalCase by splitting before capitals.
    const humanised = base
      .replace(/[_\-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim();
    if (humanised.length >= 3) pool.add(humanised);
    if (pool.size >= limit) break;
  }
  console.log(`[APK] Asset-filename signals: ${pool.size} candidates extracted`);
  return [...pool];
}

function prioritizeLabelsByVerticalSignal(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return [];
  // Pre-build a flat needle list with their vertical for diagnostic logging.
  const allNeedles = [];
  for (const [vert, needles] of Object.entries(VERTICAL_KEYWORDS)) {
    for (const n of needles) allNeedles.push({ needle: n.toLowerCase(), vert });
  }
  // Score each label by counting how many needles appear in it (substring).
  const scored = labels.map((l, idx) => {
    const lc = (l || '').toLowerCase();
    let score = 0;
    const hits = new Set();
    for (const { needle, vert } of allNeedles) {
      if (lc.includes(needle)) {
        score++;
        hits.add(vert);
      }
    }
    return { label: l, score, idx, hits: [...hits] };
  });
  // Sort: higher score first, ties broken by original order (stable).
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  // Diagnostic — count how many landed in the leading bucket and which
  // verticals were detected, so we can tell from the log whether the
  // prioritisation is actually surfacing useful labels.
  const withScore = scored.filter((s) => s.score > 0);
  if (withScore.length > 0) {
    const tally = {};
    for (const s of withScore) for (const v of s.hits) tally[v] = (tally[v] || 0) + 1;
    const topVerticals = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([v, n]) => `${v}=${n}`).join(', ');
    console.log(`[APK] Label prioritisation: ${withScore.length}/${labels.length} labels matched vertical keywords (${topVerticals})`);
  } else {
    console.log(`[APK] Label prioritisation: 0/${labels.length} labels matched any vertical keyword`);
  }
  return scored.map((s) => s.label);
}

// ─── Classify a string found in APK binaries ─────────────────────────────────
// When `manifestData` is non-null, the AXML manifest has already given us the
// authoritative values for packageName, permissions, activities, and services.
// In that mode this function only contributes SUPPLEMENTARY signals (uiStrings,
// SDKs, deep-link schemes seen in DEX, screen-name hints, feature hints) and
// does NOT overwrite manifest-derived fields.
function classifyApkStrings(allStrings, manifestData = null) {
  const haveManifest = !!manifestData;
  const result = {
    packageName:      '',
    appLabel:         '',
    activities:       [],
    services:         [],
    permissions:      [],
    deepLinkSchemes:  [],
    featureHints:     [],
    uiStrings:        [],
    sdks:             [],
    screenNames:      [],
    urls:             [],     // full HTTP(S) URLs found in strings
    hosts:            [],     // unique hostnames derived from URLs
  };

  // Patterns
  const packageRe    = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
  const activityRe   = /Activity|Fragment|Screen|Page|View$/i;
  const serviceRe    = /Service|Worker|Manager|Handler$/i;
  const permissionRe = /^android\.permission\./i;
  const schemeRe     = /^[a-z][a-z0-9+\-.]+:\/\//i;
  // Anchored SDK regex — the token must appear at start-of-string OR after a
  // dot segment separator, AND must be followed by "." or end-of-string.
  // Prevents false positives like ADJUST_PREFIX matching "adjust".
  const sdkRe        = /(?:^|\.)(firebase|mixpanel|amplitude|braze|clevertap|appsflyer|branch|adjust|segment|intercom|zendesk|stripe|paypal|razorpay|paytm|phonepe|gpay|shopify|woocommerce|algolia|elastic|twilio|sendgrid|onesignal|pusher|tensorflow|mlkit)(?:\.|$)/i;

  // HTTP(S) URLs anywhere in the APK — DEX hardcoded API endpoints, web bundle
  // refs, fallback CDN URLs. The hostname is what's vertical-revealing (an app
  // calling api.zomato.com or book.opentable.com leaves no doubt).
  const httpUrlRe = /^https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?(?:\/[^\s<>"']*)?$/i;
  // Hosts to skip — generic infra that adds noise without revealing vertical.
  const noiseHostRe = /(?:^|\.)(?:googleusercontent|gstatic|googleapis|firebaseio|crashlytics|google|amazonaws|cloudfront|jsdelivr|unpkg|fontawesome|fonts|github|githubusercontent|stackoverflow|w3|apache|mozilla|microsoft|oracle|opensource|schemas|sun|java|adobe|jetbrains|kotlinlang|github\.io)\.[a-z]{2,}$/i;

  // UI label strings — short user-facing text. Loosened vs. v1:
  //  • allow strings that start with lowercase ("welcome back" stays)
  //  • allow format markers (%s, %1$d, %@)
  //  • allow more punctuation (apostrophes, periods, hash, plus, slash, ampersand)
  // Cap length 4-80. Still excludes obvious class refs / constants by
  // requiring at least one space, OR ≥6 chars without underscore/dot.
  const uiRe = /^[A-Za-z][A-Za-z0-9 !?&'’,:.\-#\+\/%@$()]{3,79}$/;

  // Screen name hints from activity/fragment class names
  const screenKeywords = /login|signup|register|home|dashboard|profile|product|cart|checkout|payment|order|search|browse|category|filter|detail|settings|onboard|welcome|splash|feed|explore|discover|notification|camera|scan|booking|schedule|map|location|track|review|rating|reward|loyalty|referral|invite|wallet|subscription|plan|pricing|help|faq|support|chat|video|gallery|upload/i;

  // Package-name candidates (fallback path only) — keyed by string, tracking
  // how many times each one occurred. Frequent + specific (more dot segments)
  // wins, since the real app package is referenced many times across DEX.
  const pkgCandidates = new Map();

  const seen = new Set();

  for (const s of allStrings) {
    if (seen.has(s) || s.length > 200) continue;
    seen.add(s);

    // Permissions (only when no manifest — manifest scrape is authoritative)
    if (!haveManifest && permissionRe.test(s)) {
      result.permissions.push(s.replace('android.permission.', ''));
      continue;
    }

    // Deep link schemes (always — manifest catches declared schemes, this
    // catches runtime-only schemes referenced in DEX)
    if (schemeRe.test(s) && !s.startsWith('http') && !s.startsWith('https') && !s.startsWith('android')) {
      result.deepLinkSchemes.push(s);
      continue;
    }

    // HTTP(S) URLs — DEX hardcoded API endpoints. The host portion is the
    // single most vertical-revealing signal in an obfuscated app: a string
    // pointing at `api.zomato.com` removes all ambiguity about the vertical.
    if (s.length < 200 && httpUrlRe.test(s)) {
      try {
        const u = new URL(s);
        if (!noiseHostRe.test(u.hostname)) {
          result.urls.push(s);
          result.hosts.push(u.hostname.toLowerCase());
        }
      } catch (_) { /* malformed URL — skip */ }
      continue;
    }

    // SDK integrations (always — manifest rarely lists SDK packages)
    if (sdkRe.test(s) && s.length < 80) {
      result.sdks.push(s);
      continue;
    }

    // Package-like strings → activities / package candidates (fallback only)
    if (packageRe.test(s) && s.split('.').length >= 3) {
      const parts = s.split('.');
      const last  = parts[parts.length - 1];

      if (!haveManifest && activityRe.test(last)) {
        result.activities.push(s);
        const screenName = last
          .replace(/Activity|Fragment|Screen|Page$/i, '')
          .replace(/([A-Z])/g, ' $1').trim();
        if (screenName && screenName.length > 2) result.screenNames.push(screenName);
        continue;
      }

      if (!haveManifest && serviceRe.test(last)) {
        result.services.push(s);
        continue;
      }

      // Package-name candidate (fallback only). Exclude framework/SDK
      // prefixes and exclude class-like (PascalCase) trailing segments.
      if (!haveManifest && !isJunkPackageCandidate(s) && !/^[A-Z]/.test(last)) {
        pkgCandidates.set(s, (pkgCandidates.get(s) || 0) + 1);
      }
      continue;
    }

    // Screen keyword hints in any string
    if (screenKeywords.test(s) && s.length < 60) {
      result.featureHints.push(s);
    }

    // User-visible UI strings. uiRe is permissive (allows lowercase, format
    // markers, common punctuation). On top of it we require evidence the
    // string is actually English-like language, not binary noise that
    // happened to land in the printable range:
    //   • must contain a vowel (English words have vowels)
    //   • must contain a "real word" — a lowercase run of ≥3 letters, OR
    //     two Title-case words separated by space ("Order Now")
    //   • alpha ratio ≥ 0.7 (mostly letters)
    //   • either contains a space OR is ≥7 chars (kills "Wlzm", "yupSs")
    //   • not all caps with underscores, not a code-like path
    //   • not a crypto / cert-chain constant (CBG, Root CA, RSA, …)
    if (s.length >= 4 && s.length <= 80 && uiRe.test(s)) {
      const looksLikeConstant = /^[A-Z][A-Z0-9_]+$/.test(s);
      const looksLikePath     = s.includes('::') || s.startsWith('@') || /\/\//.test(s)
                                || /^res\/[\w\-]+\.\w+$/i.test(s)
                                || /^assets\//.test(s)
                                || /\.(?:xml|ttf|png|jpg|webp|otf|so|dex|arsc|properties|json)$/i.test(s);
      // Require at least one "word" of ≥4 alpha chars. Multi-token strings
      // whose parts are all short (≤3 chars) — "Ta Qr T", "ump l", "fmn u" —
      // are almost always Dalvik bytecode noise, not real UI text.
      const hasLongWord       = /[A-Za-z]{4,}/.test(s);
      const hasWordRun        = /[a-z]{3,}/.test(s) || /\b[A-Z][a-z]+\s+[A-Z][a-z]+/.test(s);
      const hasVowel          = /[aeiouAEIOU]/.test(s);
      const alphaCount        = (s.match(/[A-Za-z]/g) || []).length;
      const alphaRatio        = alphaCount / s.length;
      const hasSpaceOrLong    = s.includes(' ') || s.length >= 7;
      // Cert / X.509 / crypto noise. The DEX has the whole trusted CA list
      // baked in via SSL pinning libraries, plus the X.509 Subject location
      // strings ("Greater Manchester", "Scottsdale", etc.). None of this is
      // UI text.
      // Substring (no \b) — Subject DN strings often have trailing digits
      // like "Root CA1" / "GlobalSign0v0" that block word boundaries.
      const looksLikeCryptoCert =
        /(?:Root CA|Trust Center|Certificate Authority|Subject|Issuer|RSA|SHA[12-]?|ECDSA|GlobalSign|DigiCert|VeriSign|SecureTrust|StartCom|Comodo|GeoTrust|Symantec|Entrust|Starfield|GoDaddy|Let'?s Encrypt|Thawte|Equifax|USERTrust|AffirmTrust|IdenTrust|ISRG|T-Systems|TWCA|WoSign|ZeroSSL|OISTE|Hongkong Post|Baltimore CyberTrust|Microsoft Corporation|Cisco|Sun Microsystems|Oracle Corporation|Hewlett[ -]?Packard|QuoVadis|Actalis|TeleSec|Internet Security|GlobalRoot|cbgroot|Huawei CBG|Apple Root|Amazon Trust|X\.509|PKCS|OID)/i.test(s)
        || /^[A-Z][A-Za-z]+\d+$/.test(s)                      // "Amazon1", "Huawei1"
        || /[A-Za-z]+\d{3,}$/.test(s)                         // "Microsoft Corporation1200"
        || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\d$/.test(s)   // "Greater Manchester1", "Jersey City1"
        || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}\d\b.{0,4}$/.test(s); // similar with trailing v0, etc.
      // Encoded / binary data heuristic: real English has ≤1 lowercase→
      // uppercase transition (product names like "iPhone", "OnePlus").
      // Encoded data like "aTVgbTUtbp@" or "TArdTBqdTCsdpVH" has many.
      const internalCapsTransitions = (s.match(/[a-z][A-Z]/g) || []).length;
      const looksLikeEncoded = internalCapsTransitions >= 2;
      if (
        !looksLikeConstant && !looksLikePath && !looksLikeCryptoCert && !looksLikeEncoded &&
        hasWordRun && hasVowel && hasLongWord &&
        alphaRatio >= 0.7 && hasSpaceOrLong
      ) {
        result.uiStrings.push(s);
      }
    }
  }

  // Pick the best package candidate (fallback only). Rank by frequency × depth.
  // Frequency captures "this is the app's own package — referenced everywhere";
  // depth biases toward more specific packages (com.acme.app over com.acme).
  if (!haveManifest && pkgCandidates.size) {
    const ranked = [...pkgCandidates.entries()]
      .map(([p, count]) => ({ p, count, depth: p.split('.').length }))
      .sort((a, b) => (b.count * b.depth) - (a.count * a.depth));
    result.packageName = ranked[0].p;
  }

  // Deduplicate + limit
  result.activities    = [...new Set(result.activities)].slice(0, 40);
  result.services      = [...new Set(result.services)].slice(0, 20);
  result.permissions   = [...new Set(result.permissions)].slice(0, 30);
  result.deepLinkSchemes = [...new Set(result.deepLinkSchemes)].slice(0, 15);
  result.featureHints  = [...new Set(result.featureHints)].slice(0, 50);
  result.uiStrings     = [...new Set(result.uiStrings)].slice(0, 120);
  result.sdks          = [...new Set(result.sdks)].slice(0, 20);
  result.screenNames   = [...new Set(result.screenNames)].slice(0, 30);
  // Dedupe URLs by host (keep the first one per host so we don't store
  // https://x.com AND https://x.com:443 AND https://x.com/foo separately).
  {
    const seenHost = new Set();
    const dedup = [];
    for (const u of result.urls) {
      try {
        const h = new URL(u).hostname.toLowerCase();
        if (seenHost.has(h)) continue;
        seenHost.add(h);
        dedup.push(u);
      } catch (_) { /* skip */ }
    }
    result.urls  = dedup.slice(0, 40);
  }
  result.hosts   = [...new Set(result.hosts)].slice(0, 40);

  return result;
}

// ─── Infer app features from permissions ─────────────────────────────────────
function inferFeaturesFromPermissions(permissions) {
  const map = {
    CAMERA:                   'Camera / Photo / AR / QR Scan',
    RECORD_AUDIO:             'Voice / Audio Recording',
    ACCESS_FINE_LOCATION:     'GPS Location / Maps / Nearby',
    ACCESS_COARSE_LOCATION:   'Location Services',
    READ_CONTACTS:            'Contacts / Social Graph',
    CALL_PHONE:               'Phone / Click-to-Call',
    SEND_SMS:                 'SMS Sending',
    RECEIVE_SMS:              'OTP / SMS Auto-Read',
    READ_SMS:                 'SMS OTP Verification',
    NFC:                      'NFC / Tap-to-Pay',
    BLUETOOTH:                'Bluetooth / IoT / BLE',
    BODY_SENSORS:             'Health / Fitness Tracking',
    ACTIVITY_RECOGNITION:     'Step Counter / Fitness',
    USE_BIOMETRIC:            'Biometric Login (Fingerprint/Face)',
    USE_FINGERPRINT:          'Fingerprint Authentication',
    WRITE_EXTERNAL_STORAGE:   'File Download / Offline Content',
    READ_EXTERNAL_STORAGE:    'File Upload / Gallery Access',
    INTERNET:                 'Network / API Calls',
    VIBRATE:                  'Haptic Feedback / Notifications',
    RECEIVE_BOOT_COMPLETED:   'Background Startup / Push',
    FOREGROUND_SERVICE:       'Background Service / Music / Tracking',
    WAKE_LOCK:                'Background Processing',
  };
  return permissions
    .map(p => map[p])
    .filter(Boolean);
}

// ─── Parse resources.arsc for app name and string values ─────────────────────
function parseResourceStrings(buffer) {
  // Extract all printable + UTF-16 strings from resources binary
  const ascii   = extractPrintableStrings(buffer, 3);
  const utf16   = extractUtf16Strings(buffer, 3);
  return [...new Set([...ascii, ...utf16])];
}

// ─── Derive screen-name hints from class names ────────────────────────────
// "com.acme.shop.ProductDetailActivity" → "Product Detail"
function deriveScreenNamesFromActivities(activities) {
  const out = [];
  for (const a of activities) {
    const last = a.split('.').pop() || '';
    const name = last
      .replace(/Activity|Fragment|Screen|Page$/i, '')
      .replace(/([A-Z])/g, ' $1').trim();
    if (name && name.length > 2) out.push(name);
  }
  return [...new Set(out)];
}

// ─── Main APK signal extraction ───────────────────────────────────────────────
// Two-stage pipeline:
//   1. Parse AndroidManifest.xml as binary AXML — authoritative source for
//      packageName, permissions, activities, services, declared deep links.
//   2. String-scrape DEX/resources for supplementary signals only — UI strings,
//      SDK references, runtime deep-link schemes, screen-name hints.
// The string-scrape NEVER overwrites manifest-derived fields. If AXML parsing
// fails (rare — old or unusual builds), the string-scrape path runs in full
// "fallback mode" with the defensive filters in classifyApkStrings.
async function extractApkSignals(apkFilePath) {
  console.log('[APK] Opening:', path.basename(apkFilePath));

  let zip;
  try {
    zip = new AdmZip(apkFilePath);
  } catch (err) {
    throw new Error(`Not a valid APK file: ${err.message}`);
  }

  const entries = zip.getEntries();

  // ── Stage 1: parse AndroidManifest.xml ─────────────────────────────────────
  let manifestData = null;
  const manifestEntry = entries.find(e => !e.isDirectory && e.entryName === 'AndroidManifest.xml');
  if (manifestEntry) {
    try {
      manifestData = parseAxmlManifest(manifestEntry.getData());
      if (manifestData) {
        console.log(
          `[APK] Manifest parsed (authoritative): ` +
          `pkg=${manifestData.packageName} ` +
          `perms=${manifestData.permissions.length} ` +
          `activities=${manifestData.activities.length} ` +
          `services=${manifestData.services.length} ` +
          `schemes=${manifestData.deepLinkSchemes.length}`
        );
      } else {
        console.warn('[APK] AndroidManifest.xml present but AXML parse returned no data — falling back to string scrape');
      }
    } catch (err) {
      console.warn('[APK] AXML parser threw, falling back to string scrape:', err.message);
    }
  } else {
    console.warn('[APK] No AndroidManifest.xml entry — falling back to string scrape');
  }

  // ── Stage 2: collect supplementary strings from DEX / resources ────────────
  // DEX files are parsed via their string table (clean); everything else is
  // byte-scraped. Multidex apps ship classes.dex, classes2.dex, … — we parse
  // all shards (capped) instead of the old "first 3 scanned files" heuristic,
  // which could skip the DEX entirely once resources/assets consumed the cap.
  const allStrings = [];
  const dexEntries = [];
  let fileCount = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (entry.isDirectory) continue;
    if (/^classes\d*\.dex$/i.test(name)) { dexEntries.push(entry); continue; }
    const shouldScan =
      name === 'resources.arsc'          ||
      name.startsWith('assets/')         ||
      name.startsWith('res/values/')     ||
      name.startsWith('res/raw/');
    // Only scan the manifest as a string source when the AXML parse failed —
    // otherwise it pollutes us with binary noise and constants.
    if (!shouldScan && !(name === 'AndroidManifest.xml' && !manifestData)) continue;
    fileCount++;
    try {
      const buf = entry.getData();
      const ascii = extractPrintableStrings(buf, 4);
      const utf16 = extractUtf16Strings(buf, 4);
      allStrings.push(...ascii, ...utf16);
    } catch (_) { /* skip unreadable entries */ }
  }

  // Parse DEX string tables (multidex, capped). Sort by name so classes.dex
  // comes before classes2.dex, etc.
  const MAX_DEX = parseInt(process.env.APK_MAX_DEX || '8', 10);
  dexEntries.sort((a, b) => a.entryName.localeCompare(b.entryName));
  let dexStringCount = 0;
  for (const entry of dexEntries.slice(0, MAX_DEX)) {
    try {
      const buf = entry.getData();
      const strs = parseDexStrings(buf);
      if (strs.length) {
        dexStringCount += strs.length;
        allStrings.push(...strs);
      } else {
        // Header/bounds issue — fall back to byte-scraping this one DEX.
        allStrings.push(...extractPrintableStrings(buf, 4));
      }
    } catch (_) { /* skip unreadable DEX */ }
  }
  console.log(`[APK] Scanned ${fileCount} resource files + ${Math.min(dexEntries.length, MAX_DEX)}/${dexEntries.length} DEX (${dexStringCount} DEX strings), extracted ${allStrings.length} raw strings`);

  // ── Stage 2b: extract user-facing widget labels ───────────────────────────
  // Two sources, both producing real declared UI strings rather than the
  // byte-scrape noise from DEX:
  //   • Compiled layout XMLs (res/**/*.xml) — string pools include any
  //     inline android:text values plus tag/attr noise we filter out.
  //   • resources.arsc — the binary resource table whose global string
  //     pool holds the ACTUAL VALUES that @string/foo refs resolve to.
  //     For APKs that use path-shortening (res/-B.xml etc.), this is where
  //     the gold ("Reserve a Table", "Pump number", "Order Now") lives.
  // Both run through the same acceptLabelCandidate filter so identical
  // rules apply.
  let layoutLabels = [];
  try {
    const fromLayouts = extractLayoutLabels(entries);
    let fromArsc = [];
    const arscEntry = entries.find(e => !e.isDirectory && e.entryName === 'resources.arsc');
    if (arscEntry) {
      try {
        fromArsc = extractArscLabels(arscEntry.getData());
      } catch (err) {
        console.warn('[APK] resources.arsc parse failed:', err.message);
      }
    } else {
      console.log('[APK] No resources.arsc entry');
    }
    // Merge: arsc strings first (they're the most authoritative — actual
    // resource VALUES from the binary table), then layout strings.
    // Asset filenames — basenames of PNG/JPG/GIF/JSON/HTML resources. For
    // cross-platform apps (Flutter, RN, Capacitor) these are often the only
    // vertical-revealing strings we can extract: a food-delivery Flutter app
    // ships Resto.png / Moto.png / cart_gif.gif etc., and those basenames are
    // diagnostic on their own.
    const fromAssets = extractAssetFilenameSignals(entries);
    const merged = [...new Set([...fromArsc, ...fromLayouts, ...fromAssets])];
    // Prioritise labels that contain vertical-revealing keywords so the
    // prompt slice (typically the first 150) captures the strongest signals
    // even when the raw pool is 500+ alphabetically-ordered strings.
    layoutLabels = prioritizeLabelsByVerticalSignal(merged).slice(0, 500);
    console.log(`[APK] Combined label pool: ${layoutLabels.length} unique (arsc=${fromArsc.length}, layouts=${fromLayouts.length}, assets=${fromAssets.length})`);
  } catch (err) {
    console.warn('[APK] Layout/arsc/asset label extraction failed:', err.message);
  }

  // ── Detect cross-platform framework ──────────────────────────────────────
  // Flutter / React Native / Capacitor / Cordova / Unity / Xamarin apps
  // compile most UI text into native binaries our parsers can't read. We
  // surface this so the LLM (and the UI) can treat extraction as partial.
  const framework = detectFramework(entries);
  if (framework.kind !== 'native') {
    console.log(`[APK] Framework detected: ${framework.label} — most UI text is in native binaries we cannot parse. Relying on asset filenames + external context.`);
  }

  const classified = classifyApkStrings(allStrings, manifestData);

  // ── Merge: manifest beats scrape for structural fields ────────────────────
  const packageName     = manifestData?.packageName    || classified.packageName;
  const permissions     = manifestData ? manifestData.permissions     : classified.permissions;
  const activities      = manifestData ? manifestData.activities      : classified.activities;
  const services        = manifestData ? manifestData.services        : classified.services;
  const deepLinkSchemes = [...new Set([...(manifestData?.deepLinkSchemes || []), ...classified.deepLinkSchemes])].slice(0, 15);
  const screenNames     = manifestData
    ? deriveScreenNamesFromActivities(activities).slice(0, 30)
    : classified.screenNames;

  // ── App label fallback chain ──────────────────────────────────────────────
  // a) Manifest had a literal string label (rare — usually a @string resource)
  // b) Derive from package: com.company.appname → "Appname"
  // c) APK file name → "Acme Shop"
  let appLabel = '';
  if (manifestData?.appLabelRaw && !manifestData.appLabelRaw.startsWith('@')) {
    appLabel = manifestData.appLabelRaw;
  }
  if (!appLabel && packageName) {
    const parts = packageName.split('.');
    appLabel = parts[parts.length - 1]
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, s => s.toUpperCase())
      .trim();
  }
  if (!appLabel) {
    appLabel = path.basename(apkFilePath, '.apk')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  const inferredFeatures = inferFeaturesFromPermissions(permissions);

  // ── Own-package activity ratio ────────────────────────────────────────────
  // Even when the manifest parses cleanly, many APKs end up exposing only
  // library activities (Facebook auth, Recaptcha, Custom Tabs, CleverTap
  // Inbox, etc.) because the app's own activities were renamed to single-
  // letter names by ProGuard. In that case we have ZERO signal about what
  // the app actually does — we should not pretend to classify it.
  const ownPkgPrefix = packageName ? packageName + '.' : '';
  const ownActivities = ownPkgPrefix
    ? activities.filter((a) => a.startsWith(ownPkgPrefix))
    : [];
  const ownActivityRatio = activities.length > 0
    ? ownActivities.length / activities.length
    : 0;

  // ── Extraction-quality score (0..1) ───────────────────────────────────────
  // Below 0.5 = "we couldn't read enough to classify reliably". Surfaced to
  // the UI and the LLM prompt so the caller can soften confidence accordingly.
  const qSignals = [
    !!manifestData,
    !!packageName && !isJunkPackageCandidate(packageName),
    activities.length > 0,
    permissions.length > 0,
    classified.sdks.length > 0,
    classified.uiStrings.length >= 10 || layoutLabels.length >= 10,
    // The app must show SOME of its own activities for us to classify it
    // confidently. Heavy obfuscation pushes this to 0; a normal app sits
    // well above 0.2.
    ownActivities.length >= 2,
  ];
  const extractionQuality = qSignals.filter(Boolean).length / qSignals.length;
  const lowConfidence = extractionQuality < 0.5 || (activities.length >= 5 && ownActivityRatio < 0.15);
  if (lowConfidence) {
    console.warn(
      `[APK] LOW EXTRACTION QUALITY (${extractionQuality.toFixed(2)}) — ` +
      `manifestParsed=${!!manifestData} pkg="${packageName}" ` +
      `activities=${activities.length} ownActivities=${ownActivities.length} (ratio=${ownActivityRatio.toFixed(2)}) ` +
      `perms=${permissions.length} sdks=${classified.sdks.length}`
    );
  }

  return {
    appLabel,
    packageName,
    apkFileName:    path.basename(apkFilePath),
    activities,
    services,
    permissions,
    deepLinkSchemes,
    featureHints:   classified.featureHints,
    uiStrings:      classified.uiStrings,
    sdks:           classified.sdks,
    screenNames,
    urls:           classified.urls,
    hosts:          classified.hosts,
    layoutLabels,
    framework,
    inferredFeatures,
    manifestParsed:    !!manifestData,
    extractionQuality,
    lowConfidence,
    ownActivityRatio,
    ownActivityCount:  ownActivities.length,
  };
}

// ─── EVENT LIBRARY — multi-vertical, vertical-tagged ─────────────────────────
//
// Each example carries a `vert` tag. The prompt asks the AI to first identify
// the app's primary vertical and then generate events matching THAT vertical's
// vocabulary, treating other-vertical entries as out-of-scope.
//
// Verticals covered: social, content, messaging, ecommerce, food, fintech,
// fitness, edu, travel, rideshare, gaming, productivity, dating, health,
// utility, plus `universal` for events every mobile app benefits from.
const EVENT_LIBRARY_EXAMPLES = [
  // ── UNIVERSAL (applies to almost every app) ────────────────────────────────
  { vert: 'universal',     category: 'Acquisition', priority: 'must-have',    eventName: 'App Opened',                 triggerDescription: 'Every time the app is foregrounded (cold or warm start)', suggestedProperties: ['session_number','device_type','os_version','app_version','source','utm_campaign'] },
  { vert: 'universal',     category: 'Acquisition', priority: 'recommended',  eventName: 'Deep Link Opened',           triggerDescription: 'App launched via a deep or universal link', suggestedProperties: ['deep_link_url','scheme','campaign','source','destination_screen'] },
  { vert: 'universal',     category: 'Activation',  priority: 'must-have',    eventName: 'Account Created',            triggerDescription: 'User completes registration', suggestedProperties: ['signup_method','referral_source','phone','email','device_type'] },
  { vert: 'universal',     category: 'Activation',  priority: 'must-have',    eventName: 'Login Completed',            triggerDescription: 'User successfully logs in', suggestedProperties: ['login_method','device_type','is_returning_user','biometric_used'] },
  { vert: 'universal',     category: 'Activation',  priority: 'recommended',  eventName: 'Push Notification Opted In', triggerDescription: 'User grants push notification permission', suggestedProperties: ['device_type','os_version','prompt_trigger','source_screen'] },
  { vert: 'universal',     category: 'Retention',   priority: 'must-have',    eventName: 'Session Started',            triggerDescription: 'User begins a new app session', suggestedProperties: ['days_since_last_session','device_type','app_version','entry_screen'] },
  { vert: 'universal',     category: 'Retention',   priority: 'recommended',  eventName: 'Notification Clicked',       triggerDescription: 'User taps a push notification', suggestedProperties: ['notification_type','content_id','campaign_id','cta_text','deep_link'] },
  { vert: 'universal',     category: 'Referral',    priority: 'must-have',    eventName: 'Referral Link Shared',       triggerDescription: 'User shares their referral or invite link', suggestedProperties: ['share_channel','referral_code','incentive_type','source_screen'] },

  // ── SOCIAL (Instagram, TikTok, X, Reddit, Pinterest) ───────────────────────
  { vert: 'social',        category: 'Retention',   priority: 'must-have',    eventName: 'Post Viewed',                triggerDescription: 'A post appears in the user\'s feed or detail view', suggestedProperties: ['post_id','author_id','post_type','source_screen','position_in_feed','dwell_time_secs'] },
  { vert: 'social',        category: 'Retention',   priority: 'must-have',    eventName: 'Post Liked',                 triggerDescription: 'User likes or reacts to a post', suggestedProperties: ['post_id','author_id','reaction_type','source_screen'] },
  { vert: 'social',        category: 'Retention',   priority: 'recommended',  eventName: 'Comment Posted',             triggerDescription: 'User submits a comment on a post', suggestedProperties: ['post_id','comment_length','has_mention','has_emoji'] },
  { vert: 'social',        category: 'Activation',  priority: 'recommended',  eventName: 'Follow Tapped',              triggerDescription: 'User follows another account', suggestedProperties: ['target_user_id','source_screen','is_recommended'] },
  { vert: 'social',        category: 'Referral',    priority: 'recommended',  eventName: 'Content Shared',             triggerDescription: 'User shares a post to another app or DM', suggestedProperties: ['content_id','share_channel','content_type','recipient_count'] },

  // ── CONTENT / STREAMING (Netflix, Spotify, YouTube, news, podcasts) ────────
  { vert: 'content',       category: 'Retention',   priority: 'must-have',    eventName: 'Content Played',             triggerDescription: 'User starts playing video, audio, or article', suggestedProperties: ['content_id','content_type','title','category','duration_secs','source_screen'] },
  { vert: 'content',       category: 'Retention',   priority: 'must-have',    eventName: 'Content Completed',          triggerDescription: 'User reaches the end of a piece of content', suggestedProperties: ['content_id','watch_time_secs','completion_pct','was_resumed'] },
  { vert: 'content',       category: 'Retention',   priority: 'recommended',  eventName: 'Content Bookmarked',         triggerDescription: 'User saves content for later', suggestedProperties: ['content_id','content_type','source_screen','collection_id'] },

  // ── MESSAGING (WhatsApp, Telegram, Discord, Signal) ────────────────────────
  { vert: 'messaging',     category: 'Retention',   priority: 'must-have',    eventName: 'Message Sent',               triggerDescription: 'User sends a text, voice, or media message', suggestedProperties: ['chat_type','message_type','recipient_count','has_media'] },
  { vert: 'messaging',     category: 'Activation',  priority: 'recommended',  eventName: 'Group Created',              triggerDescription: 'User creates a new group chat', suggestedProperties: ['member_count','group_type','has_admin_invite'] },
  { vert: 'messaging',     category: 'Retention',   priority: 'recommended',  eventName: 'Voice Call Started',         triggerDescription: 'User initiates or joins a voice/video call', suggestedProperties: ['call_type','participant_count','source_screen'] },

  // ── ECOMMERCE (Amazon, Myntra, Flipkart, Etsy, D2C brands) ─────────────────
  { vert: 'ecommerce',     category: 'Retention',   priority: 'must-have',    eventName: 'Product Viewed',             triggerDescription: 'User views a product detail screen', suggestedProperties: ['product_id','product_name','category','price','brand','in_stock','rating','source_screen'] },
  { vert: 'ecommerce',     category: 'Retention',   priority: 'recommended',  eventName: 'Filter Applied',             triggerDescription: 'User applies a filter on a listing screen', suggestedProperties: ['filter_type','filter_value','category','results_count'] },
  { vert: 'ecommerce',     category: 'Revenue',     priority: 'must-have',    eventName: 'Charged',                    triggerDescription: 'CleverTap reserved event for every completed transaction', suggestedProperties: ['Amount','Payment Mode','Charged ID','Items','coupon_used','is_first_purchase'] },
  { vert: 'ecommerce',     category: 'Revenue',     priority: 'must-have',    eventName: 'Checkout Started',           triggerDescription: 'User starts the checkout flow', suggestedProperties: ['cart_total','items_count','has_coupon','source_screen'] },
  { vert: 'ecommerce',     category: 'Retention',   priority: 'recommended',  eventName: 'Order Tracked',              triggerDescription: 'User checks live order status', suggestedProperties: ['order_id','order_status','estimated_delivery','items_count'] },

  // ── FOOD DELIVERY (Swiggy, Zomato, UberEats, DoorDash) ─────────────────────
  { vert: 'food',          category: 'Retention',   priority: 'must-have',    eventName: 'Restaurant Viewed',          triggerDescription: 'User opens a restaurant detail screen', suggestedProperties: ['restaurant_id','cuisine','rating','distance_km','avg_delivery_mins'] },
  { vert: 'food',          category: 'Revenue',     priority: 'must-have',    eventName: 'Order Placed',               triggerDescription: 'User confirms a food order', suggestedProperties: ['order_total','items_count','restaurant_id','delivery_type','payment_method'] },
  { vert: 'food',          category: 'Retention',   priority: 'recommended',  eventName: 'Delivery Tracked',           triggerDescription: 'User opens live order tracking', suggestedProperties: ['order_id','order_status','estimated_mins'] },

  // ── FINTECH (Paytm, PhonePe, banking, investment, crypto) ──────────────────
  { vert: 'fintech',       category: 'Retention',   priority: 'must-have',    eventName: 'Balance Checked',            triggerDescription: 'User views account or wallet balance', suggestedProperties: ['account_type','balance_bucket','source_screen'] },
  { vert: 'fintech',       category: 'Revenue',     priority: 'must-have',    eventName: 'Money Sent',                 triggerDescription: 'User completes a transfer or payment', suggestedProperties: ['amount','recipient_type','rail','is_first_send'] },
  { vert: 'fintech',       category: 'Activation',  priority: 'must-have',    eventName: 'KYC Completed',              triggerDescription: 'User finishes identity verification', suggestedProperties: ['kyc_type','attempts','time_to_complete_mins'] },

  // ── FITNESS / HEALTH-TRACKING (Strava, MyFitnessPal, Cult, Fitbit) ─────────
  { vert: 'fitness',       category: 'Retention',   priority: 'must-have',    eventName: 'Workout Started',            triggerDescription: 'User begins a tracked workout or activity', suggestedProperties: ['activity_type','source','goal_type','planned_duration_mins'] },
  { vert: 'fitness',       category: 'Retention',   priority: 'must-have',    eventName: 'Workout Completed',          triggerDescription: 'User finishes a tracked workout', suggestedProperties: ['activity_type','duration_mins','calories_burned','distance_km'] },
  { vert: 'fitness',       category: 'Activation',  priority: 'recommended',  eventName: 'Goal Set',                   triggerDescription: 'User sets a fitness or health goal', suggestedProperties: ['goal_type','target_value','timeframe_days'] },

  // ── EDU / LEARNING (Duolingo, Byju\'s, Coursera, Khan Academy) ─────────────
  { vert: 'edu',           category: 'Retention',   priority: 'must-have',    eventName: 'Lesson Started',             triggerDescription: 'User begins a lesson, course, or learning unit', suggestedProperties: ['course_id','lesson_id','difficulty','source_screen'] },
  { vert: 'edu',           category: 'Retention',   priority: 'must-have',    eventName: 'Lesson Completed',           triggerDescription: 'User finishes a lesson successfully', suggestedProperties: ['course_id','lesson_id','score','time_spent_mins','streak_continued'] },
  { vert: 'edu',           category: 'Retention',   priority: 'recommended',  eventName: 'Quiz Submitted',             triggerDescription: 'User submits a quiz, test, or assessment', suggestedProperties: ['quiz_id','score','time_taken_mins','questions_correct'] },

  // ── TRAVEL (MakeMyTrip, Airbnb, Booking.com, Expedia) ──────────────────────
  { vert: 'travel',        category: 'Retention',   priority: 'must-have',    eventName: 'Destination Searched',       triggerDescription: 'User searches for a destination, route, or stay', suggestedProperties: ['origin','destination','travel_dates','guests','category'] },
  { vert: 'travel',        category: 'Revenue',     priority: 'must-have',    eventName: 'Booking Completed',          triggerDescription: 'User confirms a trip, flight, or stay booking', suggestedProperties: ['booking_type','total_value','duration_days','destination'] },

  // ── RIDE-SHARE (Uber, Ola, Lyft, Bolt) ─────────────────────────────────────
  { vert: 'rideshare',     category: 'Revenue',     priority: 'must-have',    eventName: 'Ride Requested',             triggerDescription: 'User requests a ride', suggestedProperties: ['pickup_area','drop_area','ride_type','fare_estimate','surge_active'] },
  { vert: 'rideshare',     category: 'Revenue',     priority: 'must-have',    eventName: 'Ride Completed',             triggerDescription: 'A ride finishes successfully', suggestedProperties: ['ride_id','duration_mins','distance_km','fare','driver_rating'] },

  // ── GAMING (mobile games with IAP / ads) ───────────────────────────────────
  { vert: 'gaming',        category: 'Retention',   priority: 'must-have',    eventName: 'Level Completed',            triggerDescription: 'Player finishes a level or stage', suggestedProperties: ['level_number','score','time_taken_secs','stars_earned'] },
  { vert: 'gaming',        category: 'Revenue',     priority: 'must-have',    eventName: 'In-App Purchase Made',       triggerDescription: 'Player buys in-game currency or items', suggestedProperties: ['sku','price','currency_type','level_at_purchase'] },
  { vert: 'gaming',        category: 'Retention',   priority: 'recommended',  eventName: 'Achievement Unlocked',       triggerDescription: 'Player unlocks an achievement or badge', suggestedProperties: ['achievement_id','rarity','progress_pct'] },

  // ── PRODUCTIVITY (Notion, Slack, Trello, Todoist) ──────────────────────────
  { vert: 'productivity',  category: 'Retention',   priority: 'must-have',    eventName: 'Document Created',           triggerDescription: 'User creates a new document, board, or workspace item', suggestedProperties: ['document_type','template_used','workspace_id','source'] },
  { vert: 'productivity',  category: 'Activation',  priority: 'recommended',  eventName: 'Collaborator Invited',       triggerDescription: 'User invites another person to a workspace or doc', suggestedProperties: ['workspace_id','role_assigned','invitee_count'] },

  // ── DATING (Tinder, Hinge, Bumble) ─────────────────────────────────────────
  { vert: 'dating',        category: 'Retention',   priority: 'must-have',    eventName: 'Profile Swiped',             triggerDescription: 'User swipes left or right on a profile', suggestedProperties: ['direction','target_profile_id','source_screen'] },
  { vert: 'dating',        category: 'Retention',   priority: 'must-have',    eventName: 'Match Made',                 triggerDescription: 'A two-sided match is created', suggestedProperties: ['match_id','swipes_to_match','is_super_like'] },

  // ── HEALTH / MEDICAL (1mg, Practo, Pharmeasy) ──────────────────────────────
  { vert: 'health',        category: 'Retention',   priority: 'must-have',    eventName: 'Appointment Booked',         triggerDescription: 'User books a doctor or service appointment', suggestedProperties: ['doctor_id','specialty','consult_type','slot_time'] },
  { vert: 'health',        category: 'Revenue',     priority: 'must-have',    eventName: 'Prescription Ordered',       triggerDescription: 'User places an order for prescription items', suggestedProperties: ['order_total','items_count','has_prescription','delivery_type'] },

  // ── UTILITY / TOOLS (weather, scanners, calculators) ───────────────────────
  { vert: 'utility',       category: 'Retention',   priority: 'must-have',    eventName: 'Tool Used',                  triggerDescription: 'User invokes the core tool action (scan, calc, lookup)', suggestedProperties: ['tool_name','input_type','result_type','source_screen'] },
  { vert: 'utility',       category: 'Retention',   priority: 'recommended',  eventName: 'Setting Changed',            triggerDescription: 'User modifies a preference or setting', suggestedProperties: ['setting_name','old_value','new_value','category'] },
];

// All vertical IDs the model is allowed to pick from.
const VERTICAL_IDS = [
  'social', 'content', 'messaging', 'ecommerce', 'food', 'fintech',
  'fitness', 'edu', 'travel', 'rideshare', 'gaming', 'productivity',
  'dating', 'health', 'utility',
];

// ─── Standard event catalog — what real businesses in each vertical track ─────
// This is the "industry benchmark" the user asked for, curated instead of
// live-searched (reliable, instant, offline-safe). It serves two jobs:
//   1. Injected (names only) into the prompt so the model has a concrete menu
//      to reach the target count with RELEVANT events instead of inventing.
//   2. Consulted by the evidence verifier so genuine vertical-standard events
//      are KEPT even when the APK's own labels are generic/obfuscated — while
//      cross-vertical hallucinations are still dropped.
const STANDARD_EVENTS = {
  food: ['Restaurant Viewed','Restaurant Searched','Cuisine Filtered','Menu Browsed','Dish Viewed','Dish Customised','Item Added','Cart Viewed','Address Added','Delivery Slot Selected','Coupon Applied','Payment Method Selected','Order Placed','Order Tracked','Order Delivered','Order Cancelled','Order Rated','Reordered','Favourite Added','Offer Viewed','Subscription Viewed','Support Contacted','Table Reserved','Tip Added'],
  ecommerce: ['Product Viewed','Category Browsed','Product Searched','Filter Applied','Sort Applied','Product Added','Cart Viewed','Wishlist Added','Coupon Applied','Address Added','Checkout Started','Payment Method Selected','Charged','Order Tracked','Order Delivered','Order Returned','Review Submitted','Product Shared','Price Drop Viewed','Recommendation Clicked'],
  fintech: ['Balance Checked','Money Sent','Money Requested','Bill Paid','Recharge Done','Beneficiary Added','KYC Completed','Card Added','Statement Viewed','Investment Made','Portfolio Viewed','Loan Applied','Reward Redeemed','Transaction Failed','Limit Updated','Autopay Enabled','Support Contacted'],
  content: ['Content Played','Content Paused','Content Completed','Content Searched','Content Bookmarked','Playlist Created','Content Downloaded','Content Shared','Subscription Started','Subscription Cancelled','Episode Viewed','Category Browsed','Recommendation Clicked','Rating Given','Cast Started'],
  social: ['Post Viewed','Post Liked','Post Created','Comment Posted','Content Shared','Follow Tapped','Profile Viewed','Story Viewed','Story Created','Reel Watched','Message Sent','Hashtag Followed','Notification Opened','Search Performed'],
  messaging: ['Message Sent','Message Received','Group Created','Voice Call Started','Video Call Started','Media Shared','Contact Added','Status Updated','Chat Archived','Reaction Added','Broadcast Sent'],
  travel: ['Destination Searched','Flight Searched','Hotel Searched','Result Filtered','Listing Viewed','Trip Saved','Booking Started','Payment Method Selected','Booking Completed','Booking Cancelled','Check-in Done','Review Submitted','Itinerary Viewed','Fare Alert Set'],
  rideshare: ['Location Set','Ride Type Selected','Fare Estimated','Ride Requested','Ride Started','Ride Completed','Ride Cancelled','Driver Rated','Payment Method Selected','Ride Scheduled','Promo Applied','Ride Shared'],
  fitness: ['Workout Started','Workout Completed','Goal Set','Progress Logged','Meal Logged','Step Count Synced','Plan Selected','Challenge Joined','Streak Continued','Reminder Set','Achievement Unlocked'],
  edu: ['Course Viewed','Lesson Started','Lesson Completed','Quiz Submitted','Assignment Submitted','Video Watched','Doubt Posted','Certificate Earned','Course Purchased','Streak Continued','Live Class Joined','Note Saved'],
  gaming: ['Game Started','Level Started','Level Completed','Achievement Unlocked','In-App Purchase Made','Reward Claimed','Leaderboard Viewed','Match Joined','Item Equipped','Ad Watched','Daily Reward Claimed'],
  health: ['Appointment Booked','Doctor Searched','Consultation Started','Prescription Ordered','Lab Test Booked','Report Viewed','Medicine Reminder Set','Symptom Checked','Payment Completed','Follow-up Scheduled'],
  productivity: ['Document Created','Document Shared','Task Created','Task Completed','Collaborator Invited','Comment Added','Workspace Created','Template Used','File Uploaded','Reminder Set','Integration Connected'],
  dating: ['Profile Viewed','Profile Swiped','Match Made','Message Sent','Super Like Sent','Profile Boosted','Filter Applied','Photo Uploaded','Subscription Purchased','Report Submitted'],
  utility: ['Tool Used','Scan Performed','Result Viewed','Setting Changed','File Saved','Export Done','Reminder Set','Widget Added'],
};

 // ─── Derive vertical hints from extracted APK signals ───────────────────────
// Heuristic-only — gives the LLM a starting point and a monetization flag so
// the prompt can require/forbid commerce events conditionally. The LLM still
// makes the final classification (it can override these hints).
// Hostname → vertical map. The hostnames an APK references in hardcoded URLs
// are extremely vertical-revealing — an obfuscated app calling api.zomato.com
// can only be one thing. Domain root tokens are matched as TLD-suffix to catch
// regional variants (zomato.in, zomato.com, zomato.ae all map to "food").
const HOST_VERTICAL_MAP = [
  // Food / restaurant
  ['food',      ['zomato', 'swiggy', 'doordash', 'ubereats', 'grubhub', 'deliveroo', 'foodpanda', 'talabat', 'careemnow', 'opentable', 'resy', 'sevenrooms', 'eatstreet', 'menulog', 'just-eat', 'rappi']],
  // Rideshare / mobility
  ['rideshare', ['uber', 'lyft', 'ola.co', 'olamoney', 'bolt.eu', 'careem', 'didi', 'grab.com', 'taxify', 'cabify', 'gett']],
  // Travel
  ['travel',    ['booking.com', 'airbnb', 'expedia', 'makemytrip', 'goibibo', 'agoda', 'trivago', 'kayak', 'skyscanner', 'tripadvisor', 'cleartrip', 'yatra', 'redbus', 'irctc']],
  // Ecommerce / shopping
  ['ecommerce', ['amazon.', 'flipkart', 'myntra', 'ajio', 'shopify', 'aliexpress', 'lazada', 'shopee', 'noon.com', 'jumia', 'mercadolibre', 'ebay', 'walmart', 'meesho']],
  // Fintech / payments / banking
  ['fintech',   ['paytm', 'phonepe', 'razorpay', 'stripe', 'paypal', 'gpay', 'cred.club', 'kotak', 'icicibank', 'hdfcbank', 'sbi.co', 'axisbank', 'revolut', 'wise.com', 'zerodha', 'upstox', 'groww', 'coinbase', 'binance', 'wazirx', 'coindcx']],
  // Health / medical
  ['health',    ['practo', 'pharmeasy', '1mg.com', 'tata1mg', 'apollo247', 'healthifyme', 'cure.fit', 'curefit']],
  // Fitness
  ['fitness',   ['strava', 'fitbit', 'myfitnesspal', 'cult.fit', 'nike.com/run', 'peloton']],
  // Edu
  ['edu',       ['byjus', 'unacademy', 'duolingo', 'coursera', 'udemy', 'khanacademy', 'edx.org', 'vedantu']],
  // Social / content
  ['social',    ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'snapchat', 'pinterest', 'reddit.com', 'linkedin.com']],
  ['content',   ['youtube.com', 'youtu.be', 'spotify', 'netflix', 'hotstar', 'jiocinema', 'sonyliv', 'zee5', 'primevideo', 'amazonvideo']],
  ['messaging', ['whatsapp', 'telegram', 'signal.me', 'discord.com', 'wechat']],
  // Dating
  ['dating',    ['tinder', 'bumble', 'hinge.co', 'okcupid', 'aisle', 'happn']],
  // Gaming
  ['gaming',    ['unity3d', 'gameanalytics', 'ironsrc', 'applovin', 'chartboost', 'vungle']],
];

function inferVerticalsFromHosts(hosts) {
  const hits = new Set();
  const matchedHosts = new Set();
  for (const h of hosts) {
    for (const [vert, needles] of HOST_VERTICAL_MAP) {
      if (needles.some((n) => h.includes(n))) {
        hits.add(vert);
        matchedHosts.add(h);
      }
    }
  }
  return { verticals: [...hits], matchedHosts: [...matchedHosts] };
}

function deriveVerticalHints(signals) {
  const sdkStr  = (signals.sdks  || []).join(' ').toLowerCase();
  const hosts   = signals.hosts || [];
  const perms   = signals.permissions || [];
  const allText = [
    signals.packageName  || '',
    ...(signals.activities   || []),
    ...(signals.services     || []),
    ...(signals.featureHints || []),
    ...(signals.uiStrings    || []),
    ...(signals.layoutLabels || []),
    ...(signals.screenNames  || []),
    ...hosts,
  ].join(' ').toLowerCase();
  const has = (kw) => allText.includes(kw) || sdkStr.includes(kw);

  const paymentSdkRe = /razorpay|stripe|paypal|paytm|gpay|phonepe|braintree|adyen|square|in_app_billing|com\.android\.billing/;
  const hasPaymentSdk = paymentSdkRe.test(sdkStr) || paymentSdkRe.test(allText);
  const hasBillingPerm = perms.some(p => /BILLING/i.test(p));
  const hasDirectMonetization = hasPaymentSdk || hasBillingPerm;

  const hints = [];
  hints.push(hasDirectMonetization
    ? 'Direct monetization detected (payment SDK or IAP billing present)'
    : 'No direct payment SDK detected — app may be free, ad-supported, or use store-managed subscriptions');

  // Hostname-based vertical inference — strongest signal we have. If the APK
  // calls api.zomato.com we should label "food" up-front and not let weaker
  // keyword hits drown the LLM in noise.
  const fromHosts = inferVerticalsFromHosts(hosts);
  if (fromHosts.verticals.length) {
    hints.push(
      `STRONG vertical signal from hardcoded URL hosts → ${fromHosts.verticals.join(', ')} ` +
      `(matched hosts: ${fromHosts.matchedHosts.slice(0, 5).join(', ')}${fromHosts.matchedHosts.length > 5 ? `, +${fromHosts.matchedHosts.length - 5} more` : ''})`
    );
  }

  const verticalHits = [...fromHosts.verticals];
  if (has('feed') || has('reel') || has('story') || has('post') || has('hashtag') || has('follower')) verticalHits.push('social');
  if (has('chat') || has('messag') || has('conversation') || has('inbox')) verticalHits.push('messaging');
  if (has('video') || has('player') || has('stream') || has('episode') || has('podcast') || has('article')) verticalHits.push('content');
  // Fitness keywords now require text-level evidence — BODY_SENSORS /
  // ACTIVITY_RECOGNITION perms alone are not sufficient (they appear in many
  // non-fitness apps that opt into step counting for engagement signals).
  if (has('workout') || has('exercise') || has('fitness') || has('calorie') || has('steps') ||
      ((perms.includes('BODY_SENSORS') || perms.includes('ACTIVITY_RECOGNITION')) && (has('activity') || has('goal') || has('cardio')))) verticalHits.push('fitness');
  if (has('lesson') || has('course') || has('quiz') || has('learn') || has('tutor')) verticalHits.push('edu');
  if (has('flight') || has('hotel') || has('itinerary') || has('trip') || has('reservation') || has('stay')) verticalHits.push('travel');
  if (has('restaurant') || has('cuisine') || has('menu') || has('delivery') || has('food') || has('table') || has('reserve') || has('dish') || has('order now')) verticalHits.push('food');
  if (has('ride') || has('driver') || has('pickup') || has('cab') || has('rider') || has('car rental') || has('vehicle')) verticalHits.push('rideshare');
  if (has('cart') || has('product') || has('checkout') || has('shop') || has('store') || has('catalog') || has('coupon')) verticalHits.push('ecommerce');
  if (has('bank') || has('wallet') || has('upi') || has('balance') || has('beneficiary') || has('ifsc') || has('portfolio') || has('mutual') || has('crypto')) verticalHits.push('fintech');
  if (has('swipe') || has('match') || (has('profile') && has('like'))) verticalHits.push('dating');
  if (has('doctor') || has('patient') || has('prescription') || has('appointment') || has('pharmacy')) verticalHits.push('health');
  if (has('level') || has('achievement') || has('xp') || (has('player') && has('score'))) verticalHits.push('gaming');
  if (has('document') || has('workspace') || has('collab') || has('task') || has('board')) verticalHits.push('productivity');

  if (verticalHits.length) {
    const ranked = [...new Set(verticalHits)];
    hints.push(`Possible verticals from text signals: ${ranked.join(', ')}`);
  } else {
    hints.push('No strong vertical signal from text (likely obfuscated build with no hardcoded API URLs) — rely on Play Store + user-provided context');
  }

  return { hints, hasDirectMonetization };
}

// ─── Helper: scale prompt counts to a user-picked target ────────────────────
// Single source of truth — used by buildApkPrompt + callAI to keep prompt
// targets and max_tokens in lockstep so the model isn't asked for 25 events
// while being given a budget for 60.
function deriveCounts(N) {
  const acq = Math.max(2, Math.round(N * 0.13));    // baseline 6/47 ≈ 13%
  const act = Math.max(2, Math.round(N * 0.16));    // baseline 8/52 ≈ 16%
  const ret = Math.max(3, Math.round(N * 0.36));    // baseline 18/52 ≈ 35%
  const ref = Math.max(1, Math.round(N * 0.10));    // baseline 5/52 ≈ 10%
  const rev = Math.max(0, Math.round(N * 0.18));    // baseline 8/52 ≈ 15%
  const mustHave    = [Math.max(1, Math.round(N * 0.18)), Math.max(2, Math.round(N * 0.26))];
  const recommended = [Math.max(1, Math.round(N * 0.40)), Math.max(2, Math.round(N * 0.50))];
  const niceToHave  = [Math.max(0, Math.round(N * 0.32)), Math.max(0, Math.round(N * 0.42))];
  // tolerance window — model gets ±5% headroom so it doesn't have to count exactly
  const minN = Math.max(1, Math.floor(N * 0.95));
  const maxN = Math.max(minN + 2, Math.ceil(N * 1.05));
  return { N, minN, maxN, acq, act, ret, ref, rev, mustHave, recommended, niceToHave };
}

// Output token cap that scales with target count. ~90 tokens per event
// (event_name + trigger + props array + reason) plus ~600 envelope. Clamped
// so a small request stays cheap and a big one doesn't blow the TPM ceiling.
function maxTokensFor(N) {
  const base = N * 105 + 600;   // ~105 tok/event incl. apkEvidence grounding string
  return Math.min(8000, Math.max(800, base));
}

// ─── Build APK-specific AI prompt ────────────────────────────────────────────
function buildApkPrompt(signals, neighbors = [], targetCount = 50, externalContext = {}, sizeOpts = {}, batchOpts = {}) {
  const { excludeNames = [], lockVertical = null } = batchOpts;
  // Batch continuation block — injected for batches after the first so the
  // model locks the vertical and produces NON-duplicate additional events.
  const batchBlock = (lockVertical || excludeNames.length)
    ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTINUATION BATCH — READ FIRST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${lockVertical ? `• The vertical is ALREADY DECIDED: "${lockVertical}". Do NOT reclassify — set detectedVertical to "${lockVertical}" and generate events for THIS vertical only.\n` : ''}${excludeNames.length ? `• These ${excludeNames.length} events were ALREADY generated in earlier batches. Do NOT repeat any of them. Produce entirely DIFFERENT, additional events that go DEEPER into the same vertical journey (more granular steps, states, and edge actions):\n${excludeNames.map((n) => `   - ${n}`).join('\n')}\n` : ''}
`
    : '';

  // Per-section caps. Defaults keep total prompt size under Groq's free-tier
  // 12k TPM ceiling. scanApk's budget-aware loop shrinks these when needed.
  const LABEL_CAP    = sizeOpts.labelCap    ?? parseInt(process.env.PROMPT_LABEL_CAP || '90', 10);
  const UI_CAP       = sizeOpts.uiCap       ?? parseInt(process.env.PROMPT_UI_CAP    || '22',  10);
  const HOSTS_CAP    = sizeOpts.hostsCap    ?? 20;
  const LIB_LEAN     = !!sizeOpts.libLean;       // drop trigger text from library examples
  const DROP_NEIGHBORS = !!sizeOpts.dropNeighbors;
  const URLS_CAP     = sizeOpts.urlsCap     ?? 12;
  const plan = deriveCounts(targetCount);
  const { playStore = null, webHint = null, userAppName = '', externalVertical = null } = externalContext;

  // External-context block — assembled when ANY of: user-typed app name,
  // user-provided reference URL, or successful Play Store lookup is available.
  // This block sits ABOVE the APK-data block in the prompt so it's the first
  // thing the LLM reads, and it's explicitly labelled as the highest-authority
  // source. Manifest signals confirm or refine; they don't override.
  const externalLines = [];
  if (userAppName) {
    externalLines.push(`• USER-PROVIDED APP NAME: "${userAppName}"`);
    externalLines.push(`  → The uploader has explicitly told you what this app is. Trust this over any name guess from the package or manifest label.`);
  }
  if (playStore?.found) {
    externalLines.push(`• OFFICIAL GOOGLE PLAY STORE METADATA (fetched live by package name):`);
    externalLines.push(`  - Title       : ${playStore.title}`);
    if (playStore.developer)   externalLines.push(`  - Developer   : ${playStore.developer}`);
    if (playStore.category)    externalLines.push(`  - Category    : ${playStore.category}${externalVertical ? `  (maps to internal vertical: "${externalVertical}")` : ''}`);
    if (playStore.description) externalLines.push(`  - Description : ${playStore.description}`);
    externalLines.push(`  → Play Store category is set by the developer and reviewed by Google. Treat it as authoritative.`);
  }
  if (webHint) {
    externalLines.push(`• USER-PROVIDED REFERENCE WEBSITE: ${webHint.url}`);
    if (webHint.title)       externalLines.push(`  - Title       : ${webHint.title}`);
    if (webHint.siteName)    externalLines.push(`  - Site name   : ${webHint.siteName}`);
    if (webHint.description) externalLines.push(`  - Description : ${webHint.description}`);
    if (webHint.keywords)    externalLines.push(`  - Keywords    : ${webHint.keywords}`);
    if (webHint.headings?.length) externalLines.push(`  - Page headings (what the business DOES): ${webHint.headings.join(' | ')}`);
    if (webHint.navText?.length)  externalLines.push(`  - Nav / button / CTA text (the core user actions): ${webHint.navText.join(' | ')}`);
    externalLines.push(`  → This is the app's brand on the web — the vertical AND the core actions described here are the source of truth. Use the headings and CTA text to name events in the business's actual vocabulary (e.g. if the site says "Track Order" / "Reorder", create those exact events).`);
  }

  // Track which of the three sources are present so we can tell the model to
  // FUSE them rather than treat context as a mere override.
  const activeSources = [];
  if (userAppName)          activeSources.push('app name');
  if (webHint)              activeSources.push('reference website');
  if (playStore?.found)     activeSources.push('Play Store listing');
  const haveAllInputs = !!userAppName && !!webHint;   // APK is always present here

  const externalContextBlock = externalLines.length
    ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXTERNAL CONTEXT (HIGHEST AUTHORITY — read this BEFORE the APK signals)
Active sources for THIS app: APK binary + ${activeSources.join(' + ') || 'none'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${externalLines.join('\n')}

INSTRUCTIONS — FUSE ALL AVAILABLE SOURCES (do not rely on any single one):
Each source has a distinct strength. Combine them:
• REFERENCE WEBSITE (title, description, headings, nav/CTA text) → the source of truth for the VERTICAL and the business's real ACTION VOCABULARY. Name events the way the site names actions ("Track Order", "Reorder", "Book Table").
• PLAY STORE category/description → authoritative confirmation of the vertical; use to break ties.
• APP NAME → the brand; trust it over any package/manifest label guess. If it hints at a sub-niche (e.g. "…Grocery", "…Pharmacy"), reflect that in the events.
• APK SIGNALS (screens, activities, layout labels, permissions, hosts, SDKs) → the EVIDENCE of what is actually BUILT. Use these to decide WHICH of the vertical's events this specific app implements, to ground each event's apkEvidence, and to add app-specific events the website didn't mention.

HOW TO RESOLVE THEM TOGETHER:
1. Determine the vertical from website + Play Store + app name (they override any APK-only guess — a generic-looking manifest does not outrank a clear website).
2. Then walk the APK signals to confirm which features exist and to enumerate concrete, implemented events at full granularity.
3. Prefer an event when MULTIPLE sources agree (e.g. website CTA "Track Order" + an OrderTrackingActivity in the APK) — mark these must-have.
4. ${haveAllInputs ? 'ALL THREE inputs (APK + app name + website) are present here — you have maximum context, so there is NO excuse for a generic or mis-classified result. Cross-check every event against at least one source.' : 'Use whichever sources are present; if only the APK is available, classify from its signals alone.'}
5. Use titles/descriptions/headings to enrich event PROPERTIES (a food app's "Order Placed" → order_total, items_count, restaurant_id, delivery_type, payment_method).

`
    : '';

  const examplesCompact = EVENT_LIBRARY_EXAMPLES.map(e =>
    LIB_LEAN
      ? `{"vert":"${e.vert}","name":"${e.eventName}","props":${JSON.stringify(e.suggestedProperties)}}`
      : `{"vert":"${e.vert}","cat":"${e.category}","pri":"${e.priority}","name":"${e.eventName}","trigger":"${e.triggerDescription}","props":${JSON.stringify(e.suggestedProperties)}}`
  ).join(',\n');

  // Format retrieved corpus neighbours as compact JSON. These are real event
  // sheets the org has curated for similar apps, so the prompt below treats
  // them as a higher-authority pattern than the generic library examples.
  //
  // Each neighbour sheet is capped at MAX_EVENTS_PER_NEIGHBOR rows (sorted
  // must-have → recommended → nice-to-have) to keep the prompt under the
  // 12k TPM ceiling on Groq's free tier. The cap is well above what a single
  // sheet needs as a pattern reference — the LLM only needs to see the shape.
  const PRIO_ORDER = { 'must-have': 0, 'recommended': 1, 'nice-to-have': 2 };
  const MAX_EVENTS_PER_NEIGHBOR = parseInt(process.env.RETRIEVAL_MAX_EVENTS_PER_NEIGHBOR || '25', 10);

  const neighborBlock = (neighbors.length && !DROP_NEIGHBORS)
    ? neighbors.map((n, idx) => {
        const trimmed = [...n.eventSheet]
          .sort((a, b) => (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9))
          .slice(0, MAX_EVENTS_PER_NEIGHBOR);
        const omitted = n.eventSheet.length - trimmed.length;
        const sheet = trimmed.map((e) =>
          `{"cat":"${e.category}","pri":"${e.priority}","name":"${e.eventName}","trigger":"${e.triggerDescription}","props":${JSON.stringify(e.suggestedProperties || [])}}`
        ).join(',\n');
        const tail = omitted > 0 ? ` (showing ${trimmed.length} of ${n.eventSheet.length} — top-priority slice)` : '';
        return `EXAMPLE ${idx + 1} — App: "${n.appName}" | Vertical: ${n.vertical || 'unknown'} | Similarity: ${n.score.toFixed(2)}${tail}\n[${sheet}]`;
      }).join('\n\n')
    : '';

  const screenList = signals.screenNames.length > 0
    ? signals.screenNames.join(', ')
    : 'Not detected';

  const activityList = signals.activities
    .map(a => a.split('.').pop())   // last segment is most readable
    .slice(0, 25)
    .join(', ');

  const permissionFeatures = signals.inferredFeatures.join(', ') || 'Standard permissions';

  const { hints: verticalHints, hasDirectMonetization } = deriveVerticalHints(signals);

  const fwKind = signals.framework?.kind || 'native';
  const fwLabel = signals.framework?.label || 'Native Android';
  const fwNote = fwKind === 'native'
    ? ''
    : ` ⚠ ${fwLabel} app — most UI strings live in native binaries we cannot parse. The asset filenames (Resto.png, Moto.png, cart_icon.png, …) included in the LAYOUT WIDGET LABELS section may be the strongest available signal. Treat the asset-derived names as semantically equivalent to button labels.`;

  const siteContext = [
    `APK File: ${signals.apkFileName}`,
    `App Name: ${signals.appLabel}`,
    `Package: ${signals.packageName}`,
    `Platform: ${fwLabel}${fwNote}`,
    ``,
    `SCREENS / ACTIVITIES DETECTED:`,
    `Activity classes: ${activityList || 'Not extracted (likely obfuscated build)'}`,
    `Screen name hints: ${screenList}`,
    ``,
    `PERMISSIONS → FEATURES:`,
    permissionFeatures,
    ``,
    `DEEP LINK SCHEMES:`,
    signals.deepLinkSchemes.join(', ') || 'None detected',
    ``,
    `LAYOUT WIDGET LABELS (★★ HIGHEST-AUTHORITY — real user-facing strings extracted from the compiled resource table (resources.arsc) and layout XMLs. ProGuard does NOT obfuscate these. COUNT the signal strength: which vertical's vocabulary appears most often? Branded loyalty currencies like "X Cash" / "Y Points" are FEATURES, not vertical signals):`,
    (signals.layoutLabels || []).slice(0, LABEL_CAP).join(' | ') || 'None extracted',
    ``,
    `HARDCODED API HOSTS (★ strong vertical signal when present):`,
    (signals.hosts || []).slice(0, HOSTS_CAP).join(', ') || 'None detected',
    ``,
    `SAMPLE HARDCODED URLS (first ${URLS_CAP}):`,
    (signals.urls || []).slice(0, URLS_CAP).join('\n') || 'None detected',
    ``,
    `SDK INTEGRATIONS:`,
    signals.sdks.join(', ') || 'Standard Android SDKs',
    ``,
    `BACKGROUND SERVICES:`,
    signals.services.slice(0, 10).map(s => s.split('.').pop()).join(', ') || 'None',
    ``,
    `UI STRINGS (supplementary — noisy byte-scrape from DEX/resources, may contain cert debris):`,
    signals.uiStrings.slice(0, UI_CAP).join(' | '),
    ``,
    `FEATURE HINT STRINGS:`,
    signals.featureHints.slice(0, 40).join(' | '),
    ``,
    `VERTICAL HINTS (derived locally — STRONG signals are prefixed "STRONG"; others may be ignored):`,
    verticalHints.map(h => `• ${h}`).join('\n'),
  ].join('\n');

  const monetizationGuidance = hasDirectMonetization
    ? `LOCAL SIGNAL: direct monetization detected. If you classify the vertical as monetized, you MUST include exactly one "Charged" event (Revenue, must-have) plus revenue events appropriate for that vertical.`
    : `LOCAL SIGNAL: no direct payment SDK detected. Unless you classify the vertical as monetized for a non-SDK reason (e.g. store-managed subscriptions for streaming/edu/dating apps), do NOT include "Charged" or transaction events.`;

  return `You are a world-class CleverTap analytics architect specialising in Android mobile apps. Analyse this APK's extracted signals and generate a comprehensive, deeply customised event tracking plan.

${batchBlock}${externalContextBlock}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APK DATA (extracted from binary)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${siteContext}

${(neighbors.length && !DROP_NEIGHBORS) ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETRIEVED EXAMPLES FROM PREVIOUSLY ANALYSED APPS (style reference only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The ${neighbors.length} example sheet${neighbors.length === 1 ? '' : 's'} below ${neighbors.length === 1 ? 'is' : 'are'} from human-curated event designs the retrieval layer scored as superficially similar to this APK. They are NOT guaranteed to share this app's vertical or business model — the corpus is sparse and retrieval can surface unrelated apps that happen to share generic Android signals.

CRITICAL — treat retrieved examples as a STYLE GUIDE, not as authority on the vertical:
• Use them for NAMING patterns, PROPERTY conventions, and PRIORITY/CATEGORY style when an event genuinely applies to this app.
• Do NOT adopt their vertical, their event set, or their business model unless the APK's own signals (package name, SDKs, permissions, deep-link schemes, UI strings, screen names) independently support it.
• If a retrieved example's vertical (e.g. "${neighbors[0].vertical || 'unknown'}") conflicts with the local hints or the APK signals for THIS app, IGNORE the example's vertical entirely and classify from the master vertical list using the APK signals alone.
• Never copy events that have no signal-level evidence in this APK (e.g. do not include "Post Liked" unless this app has a social feed; do not include "Workout Started" unless this app tracks activity).

${neighborBlock}

` : ''}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVENT DESIGN REFERENCE — MULTI-VERTICAL LIBRARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The library below contains ${EVENT_LIBRARY_EXAMPLES.length} examples spanning multiple app verticals. Each entry is tagged with a "vert" field. Treat the library as a PATTERN reference: every vertical has its own event vocabulary.

Verticals you may pick from:
${VERTICAL_IDS.join(' | ')}

(There is also a "universal" tag for events that apply to almost every app — App Opened, Account Created, Login Completed, Session Started, etc.)

Schema for every event you generate:
• category: Acquisition | Activation | Retention | Revenue | Referral
• priority: must-have | recommended | nice-to-have
• eventName: Title Case verb+noun, using THIS app's actual vocabulary
• triggerDescription: ONE precise sentence
• suggestedProperties: 4–8 snake_case keys
• reason: 1 sentence on why this event matters for THIS app

REFERENCE LIBRARY:
[${examplesCompact}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STANDARD EVENTS BY VERTICAL — INDUSTRY BENCHMARK (what real businesses in each vertical track)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After you pick the vertical, use ITS list below as your menu to reach the requested count with RELEVANT events. Include an event from this list when this specific app plausibly supports it (its screens, labels, hosts, website CTAs, or the nature of the vertical imply it). Give each your own precise trigger + properties; adapt the name to the app's own wording when the signals show it. Do NOT pull from another vertical's list.
${Object.entries(STANDARD_EVENTS).map(([v, names]) => `${v}: ${names.join(' | ')}`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK — TWO STEPS, ONE JSON RESPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — CLASSIFY THE VERTICAL (do this first, internally):
Pick exactly ONE primary vertical from the list above. SIGNAL PRIORITY for the vertical decision (highest to lowest):

1. EXTERNAL CONTEXT (user app name / Play Store category / reference website) if present — this overrides everything else.
2. LAYOUT WIDGET LABELS — these are extracted from compiled res/layout/*.xml and res/values*/strings.xml, which ProGuard does NOT obfuscate. They are the actual UI labels and resource names shipped with the app. Labels like "Reserve a Table", "Find Restaurants", "Order Now", "Add to Cart", "Browse Menu" prove FOOD. "Pickup location", "Daily rate", "Vehicle make" prove RIDESHARE/auto. "Workout", "Calories burned" prove FITNESS. snake_case resource names like "checkout_button" or "restaurant_card" are equally diagnostic. **This is your most reliable signal for any non-WebView APK.**
3. HARDCODED API HOSTS — deterministic when present. If the app calls api.zomato.com it is FOOD, period. If it calls *.uber.com it is RIDESHARE.
4. UI STRINGS (byte-scraped) — supplementary only; may include cert-chain or bytecode noise. Use only to corroborate the above.
5. SDK INTEGRATIONS — payment SDKs imply monetized commerce; mapping SDKs imply location-based service; never decide vertical alone.
6. PACKAGE NAME, ACTIVITY CLASS NAMES, SCREEN NAMES — only when the above were uninformative. Library-only activity lists (only Facebook auth, Recaptcha, WebView, etc.) are NOT a vertical signal.

Tiebreaker: pick the vertical that drives the app's core retention or revenue loop. A photo-sharing app with stories is "social", not "utility". A bank app with a referral feature is "fintech", not "utility". A restaurant-discovery + booking app is "food", not "travel".

REFUSE the temptation to fall back to "social" or "messaging" just because the app has Facebook auth and a CleverTap Inbox — those are infrastructure, not vertical.

ANTI-CONFUSION RULE — branded loyalty currencies (e.g., "CAFU Cash", "Uber Cash", "Amazon Cash", "Starbucks Stars", "X Cash", "Y Points") do NOT make an app fintech. Almost every non-fintech vertical has its own loyalty / rewards program:
   • Uber has "Uber Cash" but Uber is RIDESHARE
   • Starbucks has "Stars" but Starbucks is FOOD
   • Amazon has "Amazon Pay Balance" but Amazon is ECOMMERCE
   • Airline apps have "Miles" but they are TRAVEL
A true fintech app's CORE PRODUCT is moving money / banking / investing / lending. If you see vehicle / tyre / fuel / petrol / car / vehicle service labels alongside a loyalty currency → AUTOMOTIVE / RIDESHARE, NOT fintech. If you see restaurant / menu / order / table / cuisine labels alongside loyalty → FOOD, NOT fintech. If you see hotel / flight / booking / trip alongside loyalty → TRAVEL, NOT fintech. Loyalty programs are a FEATURE LAYERED on top of the real vertical, never the vertical itself.

COUNTING RULE — when in doubt, count the vertical-revealing labels. If 60+ labels reference vehicles / tyres / fuel and 30 reference cashback / points, the vertical is AUTOMOTIVE, not fintech. The cashback feature is a retention layer, not the product.

STEP 2 — GENERATE ${plan.minN}–${plan.maxN} EVENTS APPROPRIATE FOR THAT VERTICAL:

HARD REQUIREMENTS:

① COUNT: Generate ${plan.minN}–${plan.maxN} events. You MUST make a genuine effort to reach ${plan.minN}. The way to reach the target is NOT filler from other verticals or permission-boilerplate — it is DEPTH within THIS vertical. Break the app's core loop into its granular real steps and states. For example, a food app is not just "Order Placed" — it also has: Location/Address Set, Restaurant Searched, Cuisine/Filter Applied, Restaurant Viewed, Menu Browsed, Dish Customised, Item Added, Cart Viewed, Coupon Applied, Delivery Slot Selected, Payment Method Selected, Order Placed, Order Tracked, Order Delivered, Order Rated, Reordered, Favourite Added, Support Contacted, Offer Viewed, Subscription/Plan Viewed, etc. Every mature vertical has 25–40 such real events. Enumerate the full journey (discovery → onboarding → browse → select → transact → post-purchase → retention → referral) at this granularity. ONLY return fewer than ${plan.minN} if the app is genuinely trivial (a single-screen utility). Never invent unsupported features, but DO cover every real step of the core flow.

② VERTICAL DISCIPLINE — THIS IS THE MOST IMPORTANT RULE:
   Once you have classified the vertical, the events you generate MUST belong to that vertical's vocabulary plus the "universal" set. DO NOT mix in events from unrelated verticals.

   Examples of what this means:
   • If vertical = social/messaging/content/productivity/utility/dating/edu/fitness:
     → FORBIDDEN: "Charged", "Checkout Started", "Order Placed", "Order Tracked", "Reorder Clicked", "Return Initiated", "Payment Method Selected", "Coupon Applied", "Wallet Viewed", "Wallet Balance Checked", "Loyalty Points Redeemed", "Product Viewed", "Category Browsed", any "Cart" or "Add to Cart" variant.
     → Use that vertical's actual vocabulary: Post Viewed, Reel Watched, Story Created, Message Sent, Content Played, Workout Completed, Lesson Started, Task Completed, Profile Swiped, etc.
   • If vertical = ecommerce/food/travel/rideshare/fintech/gaming-with-IAP/health:
     → "Charged" (Revenue, must-have) is required IF this app has direct monetization (see local signal above).
     → Use revenue events appropriate for the vertical: "Order Placed" for food, "Booking Completed" for travel, "Ride Requested" for rideshare, "Money Sent" for fintech, "In-App Purchase Made" for gaming, etc.

③ MONETIZATION RULE: ${monetizationGuidance}

④ CATEGORY MINIMUMS (scaled to target count of ${plan.N}):
   Acquisition → ≥ ${plan.acq}
   Activation  → ≥ ${plan.act}
   Retention   → ≥ ${plan.ret}
   Referral    → ≥ ${plan.ref}
   Revenue     → ≥ ${plan.rev} if monetized vertical, otherwise ≥ 0 (use subscription/premium upgrade events only if applicable)

⑤ PRIORITY DISTRIBUTION (scaled to target count of ${plan.N}):
   must-have    → ${plan.mustHave[0]} to ${plan.mustHave[1]}
   recommended  → ${plan.recommended[0]} to ${plan.recommended[1]}
   nice-to-have → ${plan.niceToHave[0]} to ${plan.niceToHave[1]}

⑥ SITE-SPECIFIC LANGUAGE: Use the app's actual vocabulary. If screen names show "Feed", "Reel", "Story" — use those literal words in event names. If activities expose a "MessageThreadActivity" — create "Message Thread Opened". Do NOT invent feature names that aren't supported by the extracted signals.

⑦ PERMISSION-DRIVEN EVENTS — SEVERELY RESTRICTED. A permission being present does NOT justify an event. Generate a permission event ONLY when that capability is part of THIS vertical's CORE user loop, AND you can name the screen/label that uses it:
   • CAMERA → only if the core loop needs photos (e.g. a review-photo upload for food; a KYC selfie for fintech). NOT for generic "Camera Opened".
   • ACCESS_FINE_LOCATION → for food/rideshare/travel, ONE event max: "Location Enabled". Never "Location-Based Action".
   • USE_BIOMETRIC → ONLY fintech.  • NFC → ONLY fintech/transit/payments.  • RECORD_AUDIO → ONLY if the app's core feature is voice/audio.
   Generate AT MOST 1–2 permission-driven events total, and ONLY if they survive the rule above. When unsure, OMIT.

⑧ FULL FUNNEL: Cover discovery → first open → onboarding → first key action → repeat use → referral. Include revenue events only if vertical is monetized.

⑨ PROPERTIES: 4–8 snake_case keys per event. Add mobile properties (app_version, os_version, device_type, network_type) where relevant.

⑩ STRICT EXCLUSIONS — NEVER generate any of these unless the extracted APK signals LITERALLY contain that feature:
   • Add to Cart, Wishlist Added/Updated, Saved for Later.
   • Generic filler: "Tool Used", "Setting Changed", "Profile Updated", "Search Performed", "Sort Order Changed" — DROP these unless they are core to the vertical.
   • Media-upload spam: "Photo Uploaded", "Video Uploaded", "Audio Uploaded", "Document Uploaded", "Audio Recorded" — a food/most apps do NOT have these. Include at most ONE upload event and ONLY if a real signal (screen/label) shows user-generated media.
   • Placeholder events like "Try At Home Requested" or "Wallet Viewed".
   REACH THE TARGET THE RIGHT WAY: hit ${plan.minN}–${plan.maxN} by adding GRANULAR in-vertical events (every real step/state of the core flow), NOT by padding with the boilerplate above. Off-vertical filler is a FAILURE; a thin list because you didn't enumerate the full journey is ALSO a failure. Cover the whole vertical journey in depth.

⑪ APK EVIDENCE — GROUNDING (mandatory for every event):
   Every event MUST include an "apkEvidence" field naming the SPECIFIC extracted signal that justifies it — quote the actual layout label, screen/activity class name, hardcoded API host, deep-link scheme, permission, or SDK. Examples:
     • "Layout label: 'Reserve a Table'"
     • "Activity class: CheckoutActivity"
     • "API host: api.zomato.com"
     • "Permission: ACCESS_FINE_LOCATION"
   The ONLY events allowed to lack a specific signal are the "universal" ones (App Opened, Session Started, Account Created, Login Completed, Referral Link Shared) — for those, set apkEvidence to "Universal mobile event". If you cannot cite a real signal from the APK DATA above for a non-universal event, DO NOT generate that event.

Respond with ONLY a raw JSON object. No markdown, no backticks, no preamble.

{
  "detectedVertical": "one of: ${VERTICAL_IDS.join(' | ')}",
  "verticalReasoning": "1 sentence explaining which signals drove the classification",
  "businessVertical": "human-readable label e.g. 'Photo Sharing & Social Network'",
  "businessDescription": "2-3 sentences about this app and its users",
  "websiteType": "Android Mobile Application",
  "analyticsInsight": "2-3 sentences of CleverTap mobile strategy insight tailored to the detected vertical",
  "recommendedEvents": [
    {
      "eventName": "...",
      "priority": "must-have",
      "category": "Retention",
      "reason": "Why this event matters for this app",
      "triggerDescription": "Exactly when an Android developer fires this event",
      "suggestedProperties": ["prop_one","prop_two","prop_three","prop_four","prop_five"],
      "apkEvidence": "The specific extracted signal that justifies this event"
    }
  ]
}

Output ONLY valid JSON. Start with { end with }.`;
}

// ─── Generic HTTPS POST ───────────────────────────────────────────────────────
function httpsPost({ hostname, path: urlPath, headers, body, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('APK AI request timed out')); });
    req.write(body);
    req.end();
  });
}

// ─── Plain GET helper (follows up to 3 redirects) ────────────────────────────
function httpsGet(url, { timeout = 6000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   'GET',
        headers: {
          // Real desktop UA — Play Store serves a stripped/empty body to
          // non-browser clients otherwise.
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          res.destroy();
          const next = new URL(res.headers.location, url).toString();
          httpsGet(next, { timeout, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('GET timed out')); });
    req.end();
  });
}

// ─── Look up the app's official Play Store metadata by package name ──────────
// When the APK comes from a real published app, this gives us AUTHORITATIVE
// info that no amount of signal scraping can match: the official app title,
// the developer-declared category (e.g. "Food & Drink", "Travel & Local"),
// and the short description. This is fed into the prompt as the highest-
// authority signal — overrides local heuristics AND corpus neighbours.
//
// Failure modes (all return null, scan proceeds with what we have):
//   • Package not on Play Store (indie / sideload / regional)
//   • Play Store geoblocks / serves a no-content placeholder
//   • Timeout (default 6s, hard-capped via PLAYSTORE_TIMEOUT_MS)
//
// Disable entirely with PLAYSTORE_LOOKUP=off (no network call made).
async function lookupPlayStoreByPackage(packageName) {
  if (!packageName) return null;
  if ((process.env.PLAYSTORE_LOOKUP || 'on').toLowerCase() === 'off') return null;
  // Skip obvious junk so a fallback-mode misextraction doesn't fire a request.
  if (isJunkPackageCandidate(packageName)) return null;

  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=US`;
  const timeout = parseInt(process.env.PLAYSTORE_TIMEOUT_MS || '6000', 10);
  let html;
  try {
    html = await httpsGet(url, { timeout });
  } catch (err) {
    console.log(`[Play Store] lookup failed for ${packageName}: ${err.message}`);
    return null;
  }
  if (!html || html.length < 1000) {
    console.log(`[Play Store] empty/short body for ${packageName}`);
    return null;
  }

  // Title — Play Store always sets it as "<App Name> - Apps on Google Play"
  let title = null;
  const tMatch = /<title>([^<]+?)\s*[-–]\s*Apps on Google Play\s*<\/title>/i.exec(html);
  if (tMatch) title = decodeHtmlEntities(tMatch[1].trim());

  // Category — Play Store ships JSON-LD with "applicationCategory" (machine
  // form, e.g. FOOD_AND_DRINK) and the page also includes a human-readable
  // "genre" string ("Food & Drink"). We try both, prefer genre.
  let category = null;
  const ldMatches = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldMatches) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const data = JSON.parse(inner);
      if (typeof data.applicationCategory === 'string') category = data.applicationCategory;
      if (typeof data.genre === 'string') { category = data.genre; break; }
    } catch (_) { /* malformed JSON-LD — keep looking */ }
  }
  if (!category) {
    const gMatch = /"genre"\s*:\s*"([^"]{2,60})"/i.exec(html);
    if (gMatch) category = gMatch[1];
  }
  if (!category) {
    const cMatch = /"applicationCategory"\s*:\s*"([^"]{2,60})"/i.exec(html);
    if (cMatch) category = cMatch[1];
  }

  // Short description — the <meta name="description"> tag is concise (≤200 chars).
  let description = null;
  const dMatch = /<meta\s+name="description"\s+content="([^"]+)"/i.exec(html);
  if (dMatch) description = decodeHtmlEntities(dMatch[1].trim());

  // Developer — appears as `"author":{"@type":"Person","name":"Acme Inc"}`
  let developer = null;
  const devMatch = /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{1,80})"/i.exec(html);
  if (devMatch) developer = decodeHtmlEntities(devMatch[1].trim());

  // If we couldn't even get a title back, the page is a 404 / placeholder.
  if (!title) {
    console.log(`[Play Store] no title found in body for ${packageName} — likely 404`);
    return null;
  }

  const result = {
    found:       true,
    url,
    title,
    developer:   developer || null,
    category:    category  || null,
    description: description ? description.slice(0, 600) : null,
  };
  console.log(
    `[Play Store] Found: "${result.title}" by ${result.developer || 'unknown'} | ` +
    `Category: ${result.category || 'unknown'}`
  );
  return result;
}

// ─── Lightweight website-hint fetcher ────────────────────────────────────────
// When the client provides a reference URL (their company's website or the
// app's landing page), we fetch the homepage once and pull out the cheap,
// high-signal metadata: <title>, meta description, OpenGraph site_name and
// description. This is intentionally NOT a full crawl — we already have one
// of those in scanner.js, and it costs 15-30s with Puppeteer. Here we want a
// fast, complementary hint that confirms (or contradicts) the APK signals.
async function fetchWebsiteHints(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;
    new URL(url);   // validate
  } catch (_) {
    console.log(`[Web Hint] invalid URL: ${rawUrl}`);
    return null;
  }
  const timeout = parseInt(process.env.WEBHINT_TIMEOUT_MS || '5000', 10);
  let html;
  try {
    html = await httpsGet(url, { timeout });
  } catch (err) {
    console.log(`[Web Hint] fetch failed for ${url}: ${err.message}`);
    return null;
  }
  if (!html) return null;

  const head = html.slice(0, 80000);   // <head> + top of <body>
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const descMatch  = /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(head)
                  || /<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(head);
  const ogSiteMatch = /<meta\s+[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(head);
  const ogDescMatch = /<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(head);
  const kwMatch     = /<meta\s+[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i.exec(head);

  // Strip tags → plain text, collapse whitespace.
  const strip = (t) => decodeHtmlEntities(String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const dedupe = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

  // Headings (H1–H3) — the clearest statement of what the business does
  // ("Order food online", "Book a doctor", "Send money instantly").
  const headings = [];
  let hm, hc = 0;
  const hRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  while ((hm = hRe.exec(html)) && hc < 50) {
    const t = strip(hm[1]);
    if (t.length >= 3 && t.length <= 120) { headings.push(t); hc++; }
  }

  // Nav / CTA / button text — reveals the app's core actions
  // ("Menu", "Track Order", "Offers", "Restaurants near you").
  const cta = [];
  let am, ac = 0;
  const aRe = /<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi;
  while ((am = aRe.exec(html)) && ac < 300) {
    const t = strip(am[1]);
    if (t.length >= 3 && t.length <= 40 && /[a-z]/i.test(t)) { cta.push(t); ac++; }
  }

  const result = {
    url,
    title:       titleMatch ? decodeHtmlEntities(titleMatch[1].trim()).slice(0, 200) : null,
    siteName:    ogSiteMatch ? decodeHtmlEntities(ogSiteMatch[1].trim()).slice(0, 100) : null,
    description: decodeHtmlEntities((ogDescMatch?.[1] || descMatch?.[1] || '').trim()).slice(0, 500) || null,
    keywords:    kwMatch ? decodeHtmlEntities(kwMatch[1].trim()).slice(0, 300) : null,
    headings:    dedupe(headings).slice(0, 25),
    navText:     dedupe(cta).slice(0, 30),
  };
  if (!result.title && !result.description && !result.headings.length) {
    console.log(`[Web Hint] no usable content at ${url}`);
    return null;
  }
  console.log(
    `[Web Hint] ${url} → title="${result.title || '?'}" ` +
    `headings=${result.headings.length} nav=${result.navText.length} ` +
    `desc="${(result.description || '').slice(0, 60)}…"`
  );
  return result;
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// Map Play Store's machine categories to our internal vertical names so the
// LLM gets a deterministic signal rather than a free-text genre. Anything not
// in this map falls through and the LLM gets the raw category string.
function mapPlayStoreCategory(cat) {
  if (!cat) return null;
  const k = cat.toUpperCase().replace(/[\s&]+/g, '_').replace(/[^A-Z_]/g, '');
  const M = {
    FOOD_AND_DRINK:        'food',
    SHOPPING:              'ecommerce',
    TRAVEL_AND_LOCAL:      'travel',
    MAPS_AND_NAVIGATION:   'travel',
    FINANCE:               'fintech',
    SOCIAL:                'social',
    COMMUNICATION:         'messaging',
    DATING:                'dating',
    HEALTH_AND_FITNESS:    'fitness',
    MEDICAL:               'health',
    EDUCATION:             'edu',
    BOOKS_AND_REFERENCE:   'edu',
    VIDEO_PLAYERS_AND_EDITORS: 'content',
    MUSIC_AND_AUDIO:       'content',
    ENTERTAINMENT:         'content',
    NEWS_AND_MAGAZINES:    'content',
    PRODUCTIVITY:          'productivity',
    BUSINESS:              'productivity',
    TOOLS:                 'utility',
    LIFESTYLE:             'utility',
    AUTO_AND_VEHICLES:     'rideshare',
    HOUSE_AND_HOME:        'utility',
    PARENTING:             'utility',
    PHOTOGRAPHY:           'content',
    PERSONALIZATION:       'utility',
    WEATHER:               'utility',
  };
  // Game_* maps to gaming
  if (k.startsWith('GAME')) return 'gaming';
  return M[k] || null;
}

// ─── AI provider router (mirrors scanner.js) ─────────────────────────────────
// maxTokensHint is the budget our prompt-plan needs — providers may apply
// their own caps on top. Groq additionally clamps to its free-tier safe ceiling.
async function callAI(prompt, maxTokensHint = 4500) {
  // ── Provider preference ────────────────────────────────────────────────────
  // Claude follows the multi-rule, stay-in-vertical prompt far more reliably
  // than Llama/Gemini, so when an Anthropic key is present we use it FIRST
  // (override with AI_PROVIDER=groq|gemini). This is the single biggest lever
  // for event-suggestion accuracy.
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (process.env.ANTHROPIC_API_KEY && provider !== 'groq' && provider !== 'gemini') {
    const maxTokens = Math.min(8000, Math.max(800, maxTokensHint));
    console.log(`[APK AI] Using Anthropic Claude (preferred, max_tokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      headers:  { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:       process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens:  maxTokens,
        temperature: 0.2,
        messages:    [{ role: 'user', content: prompt }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Anthropic error: ${parsed.error.message}`);
    return parsed.content?.[0]?.text || '';
  }

  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-04-17';
    const maxTokens = Math.min(8000, Math.max(800, maxTokensHint));
    console.log(`[APK AI] Using Gemini (${model}, maxOutputTokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      headers:  { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Gemini error: ${parsed.error.message}`);
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    // Groq's free tier caps a single request's total token budget (input +
    // output) at 12k TPM. 5000 is the practical safe ceiling for output here
    // (leaves ~7k for input). Bump GROQ_MAX_TOKENS on paid plans.
    const safeCeiling = parseInt(process.env.GROQ_MAX_TOKENS || '5000', 10);
    const maxTokens = Math.min(safeCeiling, Math.max(800, maxTokensHint));
    console.log(`[APK AI] Using Groq (${model}, max_tokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      headers:  { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens:  maxTokens,
        temperature: 0.2,
        ...((process.env.GROQ_MODEL || 'openai/gpt-oss-120b').includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        messages:    [{ role: 'user', content: prompt }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Groq error: ${parsed.error.message}`);
    return parsed.choices?.[0]?.message?.content || '';
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const maxTokens = Math.min(8000, Math.max(800, maxTokensHint));
    console.log(`[APK AI] Using Anthropic Claude (max_tokens=${maxTokens})`);
    const raw = await httpsPost({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Anthropic error: ${parsed.error.message}`);
    return parsed.content?.[0]?.text || '';
  }

  throw new Error('No AI API key found. Set GEMINI_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY.');
}

// ─── Salvage a truncated AI JSON response ────────────────────────────────────
// Recovers the top-level string fields and every COMPLETE object inside the
// recommendedEvents array, even when the response was cut off mid-array (Groq
// output-token cap). Each event object is self-contained JSON, so we scan the
// array body and JSON.parse each balanced {...} block, ignoring the final
// incomplete one. Returns null if we can't even find the array.
function salvageTruncatedJson(text) {
  const out = {};
  const grabStr = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    if (m) { try { out[key] = JSON.parse(`"${m[1]}"`); } catch (_) { out[key] = m[1]; } }
  };
  ['detectedVertical', 'verticalReasoning', 'businessVertical', 'businessDescription', 'websiteType', 'analyticsInsight'].forEach(grabStr);

  const arrStart = text.indexOf('"recommendedEvents"');
  if (arrStart === -1) return null;
  const bracket = text.indexOf('[', arrStart);
  if (bracket === -1) return null;

  const events = [];
  let i = bracket + 1;
  while (i < text.length) {
    // Find the next object start.
    while (i < text.length && text[i] !== '{' && text[i] !== ']') i++;
    if (i >= text.length || text[i] === ']') break;
    // Walk to the matching close brace, respecting strings/escapes.
    let depth = 0, inStr = false, esc = false, start = i;
    for (; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) break;   // last object was truncated — stop
    try { events.push(JSON.parse(text.slice(start, i))); } catch (_) { /* skip malformed */ }
  }

  if (!events.length) return null;
  out.recommendedEvents = events;
  return out;
}

// ─── Parse AI response (same logic as scanner.js) ────────────────────────────
function parseAIResponse(rawReply, appLabel) {
  try {
    const cleaned = rawReply
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in AI response');

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      // Truncation salvage — on Groq's free tier a large event list can exceed
      // the output-token cap and get cut off mid-array, so strict JSON.parse
      // fails. Rather than fall back to 3 stub events, recover the top-level
      // string fields and every COMPLETE event object emitted before the cut.
      console.warn(`[APK Scanner] Strict JSON parse failed (${parseErr.message}) — attempting truncation salvage`);
      parsed = salvageTruncatedJson(cleaned);
      if (!parsed) throw parseErr;
      console.log(`[APK Scanner] Salvaged ${parsed.recommendedEvents.length} complete events from truncated response`);
    }

    if (!Array.isArray(parsed.recommendedEvents)) {
      throw new Error('recommendedEvents is not an array');
    }

    parsed.detectedVertical = VERTICAL_IDS.includes(parsed.detectedVertical)
      ? parsed.detectedVertical
      : 'utility';
    parsed.verticalReasoning = typeof parsed.verticalReasoning === 'string'
      ? parsed.verticalReasoning
      : '';

    parsed.recommendedEvents = parsed.recommendedEvents.map(e => ({
      eventName:           e.eventName           || 'Unknown Event',
      priority:            ['must-have','recommended','nice-to-have'].includes(e.priority) ? e.priority : 'recommended',
      category:            ['Acquisition','Activation','Retention','Revenue','Referral'].includes(e.category) ? e.category : 'Retention',
      reason:              e.reason              || `Tracks ${(e.eventName || '').toLowerCase()}.`,
      triggerDescription:  e.triggerDescription  || 'Fire when this action occurs.',
      suggestedProperties: Array.isArray(e.suggestedProperties) ? e.suggestedProperties : ['Date'],
      apkEvidence:         (typeof e.apkEvidence === 'string' && e.apkEvidence.trim()) ? e.apkEvidence.trim() : 'Universal mobile event (no specific APK signal)',
    }));

    console.log(`[APK Scanner] Parsed ${parsed.recommendedEvents.length} events for vertical "${parsed.detectedVertical}"`);
    return parsed;

  } catch (err) {
    console.warn('[APK Scanner] Parse failed:', err.message);
    return {
      detectedVertical:    'utility',
      verticalReasoning:   'Fallback — AI response could not be parsed.',
      businessVertical:    'Mobile Application',
      businessDescription: `${appLabel} — an Android mobile app.`,
      websiteType:         'Android Mobile Application',
      analyticsInsight:    'Track the full mobile funnel from install to repeat use.',
      recommendedEvents: [
        { eventName: 'App Opened',      priority: 'must-have', category: 'Acquisition', reason: 'Baseline session tracking.',  triggerDescription: 'Every app foreground.',        suggestedProperties: ['app_version','os_version','device_type'] },
        { eventName: 'Account Created', priority: 'must-have', category: 'Activation',  reason: 'Tracks new registrations.',   triggerDescription: 'User completes registration.', suggestedProperties: ['signup_method','referral_source','device_type'] },
        { eventName: 'Session Started', priority: 'must-have', category: 'Retention',   reason: 'Tracks app re-engagement.',   triggerDescription: 'New foreground session begins.', suggestedProperties: ['days_since_last_session','device_type','app_version'] },
      ],
    };
  }
}

// ─── Main exported scan function ─────────────────────────────────────────────
// ─── Deterministic event sanitizer ──────────────────────────────────────────
// Groq/Llama does not reliably obey the "stay in-vertical, no filler" prompt
// rules, so we enforce them in code AFTER the model returns. Each rule drops a
// class of generic-boilerplate event UNLESS the APK actually shows evidence for
// it (a matching permission, or the app's detected vertical genuinely uses it).
// This is what makes the output trustworthy regardless of the model's quality.
function sanitizeEvents(events, { vertical, permissions }) {
  if (!Array.isArray(events)) return [];
  const perms = new Set((permissions || []).map(p => String(p).toUpperCase()));
  const V = String(vertical || '').toLowerCase();

  // name-matcher helpers
  const is = (name, re) => re.test(name);

  const dropped = [];
  const kept = events.filter(e => {
    const n = String(e.eventName || '').toLowerCase().trim();

    // 1) Always-drop low-value filler (unless the app is a utility/tools app).
    if (is(n, /^(setting changed|sort order changed|profile updated|search performed|tool used)$/)) {
      if (V !== 'utility') { dropped.push(e.eventName); return false; }
    }
    // 2) Media-upload spam — only social/content/messaging legitimately have it.
    if (is(n, /(photo|video|audio|document|file|image)\s*(upload|uploaded)/)) {
      if (!['social', 'content', 'messaging'].includes(V)) { dropped.push(e.eventName); return false; }
    }
    // 3) Audio recording — only voice/audio-centric verticals.
    if (is(n, /audio recorded|voice recorded/)) {
      if (!perms.has('RECORD_AUDIO') || !['messaging', 'content', 'social'].includes(V)) { dropped.push(e.eventName); return false; }
    }
    // 4) Camera / photo capture — require the CAMERA permission.
    if (is(n, /camera opened|photo captured|photo taken|scan(ned)? (qr|barcode)/)) {
      if (!perms.has('CAMERA')) { dropped.push(e.eventName); return false; }
    }
    // 5) Biometric — fintech only.
    if (is(n, /biometric|fingerprint|face id/)) {
      if (V !== 'fintech' && !perms.has('USE_BIOMETRIC') && !perms.has('USE_FINGERPRINT')) { dropped.push(e.eventName); return false; }
    }
    // 6) NFC — fintech/transit/payments only, and require the permission.
    if (is(n, /\bnfc\b|tap[- ]?to[- ]?pay/)) {
      if (V !== 'fintech' || !perms.has('NFC')) { dropped.push(e.eventName); return false; }
    }
    return true;
  });

  if (dropped.length) {
    console.log(`[APK Scanner] Sanitizer dropped ${dropped.length} off-vertical/filler event(s): ${dropped.join(', ')}`);
  }
  return kept;
}

// ─── Evidence verifier — the precision gate ──────────────────────────────────
// The sanitizer removes KNOWN filler. This goes further: it drops any event
// whose vocabulary appears NOWHERE in the actually-extracted evidence (APK
// labels, screen/class names, hosts, permissions, SDKs, deep links + the
// reference website's title/description/headings/CTAs). If the model invented
// an event with no grounding in anything we truly observed, it is removed.
//
// Safety rails so we never gut a legitimate list:
//   • Universal lifecycle events are always allowed (they need no vertical signal).
//   • If the evidence corpus is too thin to judge fairly (heavily obfuscated
//     APK + no website), verification is SKIPPED and we trust the sanitizer only.
//   • An event is kept if ANY meaningful token from its name OR its stated
//     apkEvidence is found in the corpus — we only drop ZERO-overlap events.
function verifyEventsAgainstEvidence(events, { signals, webHint, vertical }) {
  if (!Array.isArray(events) || !events.length) return events;
  if ((process.env.APK_VERIFY_EVIDENCE || 'on').toLowerCase() === 'off') return events;

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Industry-standard event vocabulary for the detected vertical — these are
  // legitimate even when the APK's own labels are generic/obfuscated, because
  // "businesses in this vertical track this" is itself valid grounding.
  const stdTokens = new Set(
    norm((STANDARD_EVENTS[String(vertical || '').toLowerCase()] || []).join(' '))
      .split(' ').filter((t) => t.length >= 4)
  );

  const corpusParts = [
    ...(signals.layoutLabels || []),
    ...(signals.activities   || []).map(a => a.split('.').pop()),
    ...(signals.services     || []).map(s => s.split('.').pop()),
    ...(signals.screenNames  || []),
    ...(signals.featureHints || []),
    ...(signals.uiStrings    || []),
    ...(signals.hosts        || []),
    ...(signals.deepLinkSchemes || []),
    ...(signals.sdks         || []),
    ...(signals.permissions  || []),
    signals.appLabel, signals.packageName,
    webHint?.title, webHint?.description, webHint?.keywords,
    ...((webHint?.headings) || []),
    ...((webHint?.navText)  || []),
  ];
  const corpus = ' ' + norm(corpusParts.join(' ')) + ' ';

  // Distinct meaningful tokens in the corpus — if too few, we can't judge.
  const corpusTokens = new Set(corpus.split(' ').filter(t => t.length >= 4));
  if (corpusTokens.size < 15) {
    console.log(`[APK Scanner] Evidence verifier SKIPPED — corpus too thin (${corpusTokens.size} tokens); trusting sanitizer only`);
    return events;
  }

  // Always-allowed lifecycle / universal events (no vertical evidence required).
  const UNIVERSAL = /\b(app (opened|launched|installed|updated)|session (started|ended)|account created|sign ?up|signup|register(ed|ation)?|login|logged in|log in|deep ?link|notification|push|referral|onboard|permission granted|app rated|logout|log out)\b/;

  // Tokens we ignore when judging an event (verbs / generic connectors).
  const STOP = new Set(['the','and','for','with','from','into','your','this','that','when','user','users','event','events','page','screen','view','viewed','open','opened','start','started','complete','completed','create','created','add','added','select','selected','apply','applied','click','clicked','tap','tapped','make','made','place','placed','used','using','share','shared','update','updated','submit','submitted','change','changed','enable','enabled','initiate','initiated','request','requested','track','tracked','browse','browsed','search','searched']);

  const dropped = [];
  const kept = events.filter((e) => {
    const nameN = norm(e.eventName);
    if (UNIVERSAL.test(nameN)) return true;

    const toks = norm(`${e.eventName} ${e.apkEvidence || ''}`)
      .split(' ')
      .filter((t) => t.length >= 4 && !STOP.has(t));
    if (!toks.length) return true;   // nothing judgeable → keep

    // Keep if grounded in the APK/website corpus OR it's a standard event for
    // the detected vertical. Drop only if it matches NEITHER (true hallucination).
    const inCorpus  = toks.some((t) => corpus.includes(` ${t} `) || corpus.includes(t));
    const inVertical = toks.some((t) => stdTokens.has(t));
    if (!inCorpus && !inVertical) { dropped.push(e.eventName); return false; }
    return true;
  });

  if (dropped.length) {
    console.log(`[APK Scanner] Evidence verifier dropped ${dropped.length} ungrounded event(s): ${dropped.join(', ')}`);
  }
  return kept;
}

async function scanApk(apkFilePath, opts = {}) {
  // targetCount: how many events the model should produce. Clamped 10..80.
  // Drives both the prompt's required count and the AI's max_tokens budget.
  const targetCount = Math.max(10, Math.min(80, parseInt(opts.targetCount, 10) || 50));

  // Optional client-provided context — when the uploader knows what the app
  // IS (and they almost always do), pass it in. This and the Play Store
  // lookup below give us a vertical signal the manifest alone cannot.
  const userAppName     = typeof opts.appNameHint     === 'string' ? opts.appNameHint.trim().slice(0, 120) : '';
  const userReferenceUrl = typeof opts.referenceUrl   === 'string' ? opts.referenceUrl.trim().slice(0, 300)  : '';

  console.log(`[APK Scanner] Starting analysis (target: ${targetCount} events)…`);
  if (userAppName)      console.log(`[APK Scanner] User-provided app name : "${userAppName}"`);
  if (userReferenceUrl) console.log(`[APK Scanner] User-provided reference URL: ${userReferenceUrl}`);

  const signals  = await extractApkSignals(apkFilePath);
  console.log(`[APK Scanner] App: "${signals.appLabel}" | Package: ${signals.packageName}`);
  console.log(`[APK Scanner] Screens: ${signals.screenNames.length} | Permissions: ${signals.permissions.length} | SDKs: ${signals.sdks.length}`);

  // Look up Play Store + (if provided) the reference URL in parallel — both
  // are independent of each other and add ~2-6s combined when present.
  const [playStore, webHint] = await Promise.all([
    lookupPlayStoreByPackage(signals.packageName).catch((e) => {
      console.warn('[Play Store] unhandled error:', e.message);
      return null;
    }),
    userReferenceUrl
      ? fetchWebsiteHints(userReferenceUrl).catch((e) => {
          console.warn('[Web Hint] unhandled error:', e.message);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const externalVertical = mapPlayStoreCategory(playStore?.category) || null;
  if (externalVertical) {
    console.log(`[Play Store] Mapped category "${playStore.category}" → vertical "${externalVertical}"`);
  }

  // Retrieve similar apps from the training corpus. Failures here are non-
  // fatal — without neighbours the prompt falls back to today's library-only
  // behaviour, so a broken corpus never breaks the scan.
  let neighbors = [];
  try {
    // topK is intentionally small (2) to keep the prompt under Groq's
    // free-tier 12k TPM ceiling. Bump via RETRIEVAL_TOPK on paid plans.
    const TOPK = parseInt(process.env.RETRIEVAL_TOPK || '2', 10);
    // minScore is the rank-normalised BM25 floor (top result is always 1.0,
    // so this only filters the 2nd/3rd-ranked). Coverage is the real signal:
    // the fraction of unique query tokens that actually appear in the
    // candidate doc. With a sparse corpus, the top neighbour can have
    // coverage as low as 5–10% — i.e. it shares only generic Android
    // boilerplate — and absolutely should not be treated as relevant.
    const MIN_SCORE    = parseFloat(process.env.RETRIEVAL_MIN_SCORE    || '0.55');
    const MIN_COVERAGE = parseFloat(process.env.RETRIEVAL_MIN_COVERAGE || '0.35');
    neighbors = trainingStore.retrieve(signals, {
      topK:        TOPK,
      minScore:    MIN_SCORE,
      minCoverage: MIN_COVERAGE,
    });
    if (neighbors.length) {
      console.log(
        `[APK Scanner] Retrieval: ${neighbors.length} neighbour(s) — ` +
        neighbors.map((n) =>
          `${n.appName} (${n.vertical || '—'}, score=${n.score.toFixed(2)}, coverage=${(n.coverage ?? 0).toFixed(2)})`
        ).join(', ')
      );
    } else {
      console.log(`[APK Scanner] Retrieval: no neighbours cleared minScore=${MIN_SCORE} & minCoverage=${MIN_COVERAGE}; using library only`);
    }
  } catch (err) {
    console.warn('[APK Scanner] Retrieval failed, continuing without neighbours:', err.message);
  }

  const externalCtx = { playStore, webHint, userAppName, externalVertical };

  // Confirm which signals are fused for this run (visible in the demo console).
  console.log(
    `[APK Scanner] Signal fusion → APK:yes · appName:${userAppName ? 'yes' : 'no'} · ` +
    `website:${webHint ? 'yes' : 'no'} · playStore:${playStore?.found ? 'yes' : 'no'}` +
    (webHint?.headings?.length ? ` · site-headings:${webHint.headings.length}` : '')
  );

  // One generation call — builds the prompt, calls the AI, and auto-retries
  // with a shrunken payload if the provider rejects it as too large (Groq's
  // free-tier 12k TPM ceiling). Returns the parsed result.
  // Budget-aware generation. Groq's free tier caps input+output at 12k TPM,
  // so instead of hoping a prompt fits, we estimate its size and pick both the
  // prompt caps AND the output budget to stay under the ceiling — trimming the
  // biggest blocks (labels, then library/neighbours) only as needed.
  const runGeneration = async (count, batchOpts = {}) => {
    const buildAt = (caps) => buildApkPrompt(signals, neighbors, count, externalCtx, caps, batchOpts);
    const estTokens = (p) => Math.ceil(p.length / 4);
    const TPM = parseInt(process.env.GROQ_TPM_BUDGET || '11200', 10); // safety margin under 12000
    const MIN_OUT = 900;   // need at least this much room for a usable response

    const desiredOut = maxTokensFor(count);
    const usingGroq = !!process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY;
    let prompt, maxTokens = desiredOut;

    if (!usingGroq) {
      // Claude/Gemini have large context — send the full, richest prompt.
      prompt = buildAt({});
    } else {
      // Groq's 12k TPM is tight, so we make room by trimming GENERIC bulk
      // (verbose library text + the sparse junk corpus) while KEEPING the
      // app-specific signals that drive relevance — layout labels, screens,
      // hosts. The cascade only trims labels as a last resort, and never below
      // a level that still lets the model ground app-specific events.
      const steps = [
        { libLean: true, dropNeighbors: true, labelCap: 130, uiCap: 15 },
        { libLean: true, dropNeighbors: true, labelCap: 100, uiCap: 12 },
        { libLean: true, dropNeighbors: true, labelCap: 75,  uiCap: 8  },
        { libLean: true, dropNeighbors: true, labelCap: 55,  uiCap: 6  },
      ];
      for (let s = 0; s < steps.length; s++) {
        prompt = buildAt(steps[s]);
        const room = TPM - estTokens(prompt);
        if (room >= desiredOut) { maxTokens = desiredOut; break; }   // full output fits — keep the richest labels
        if (s === steps.length - 1) {
          maxTokens = Math.max(MIN_OUT, room);
          if (room < MIN_OUT) console.warn(`[APK Scanner] Prompt still large after max shrink (~${estTokens(prompt)} tok) — output budget ${maxTokens}`);
        }
      }
    }
    console.log(`[APK Scanner] Prompt ~${estTokens(prompt)} tok · output budget ${maxTokens} · requesting ~${count} events`);

    let rawReply;
    try {
      rawReply = await callAI(prompt, maxTokens);
    } catch (err) {
      const msg = String(err && err.message || '');
      const looksTooLarge = /tokens per minute|TPM|too large|request_too_large|prompt is too long|context_length_exceeded|too many tokens/i.test(msg);
      if (!looksTooLarge) throw err;
      console.warn(`[APK Scanner] Provider still rejected as too large — final minimal retry. (${msg.slice(0, 120)}…)`);
      const minimal = buildAt({ libLean: true, dropNeighbors: true, labelCap: 40, uiCap: 6, hostsCap: 6, urlsCap: 3 });
      rawReply = await callAI(minimal, 1500);
    }
    return parseAIResponse(rawReply, signals.appLabel);
  };

  // Large targets don't fit one Groq free-tier response (~5k output tokens),
  // so we generate in batches and merge. Batch 1 fixes the vertical; later
  // batches are told which events already exist and to produce DIFFERENT ones.
  const BATCH_MAX = parseInt(process.env.APK_BATCH_SIZE || '25', 10);
  let aiResult;
  if (targetCount <= BATCH_MAX) {
    console.log(`[APK Scanner] Single generation — requesting ~${targetCount} events`);
    aiResult = await runGeneration(targetCount);
  } else {
    const nBatches = Math.ceil(targetCount / BATCH_MAX);
    const perBatch = Math.ceil(targetCount / nBatches);
    console.log(`[APK Scanner] Batched generation — ${targetCount} events across ${nBatches} batches of ~${perBatch}`);
    const merged = [];
    const seen = new Set();
    let base = null, lockVertical = null;
    for (let i = 0; i < nBatches && merged.length < targetCount; i++) {
      const r = await runGeneration(perBatch, {
        excludeNames: merged.map((e) => e.eventName),
        lockVertical,
      });
      if (!base) base = r;
      if (!lockVertical && r.detectedVertical) lockVertical = r.detectedVertical;
      let added = 0;
      for (const e of (r.recommendedEvents || [])) {
        const key = String(e.eventName || '').toLowerCase().trim();
        if (key && !seen.has(key)) { seen.add(key); merged.push(e); added++; }
      }
      console.log(`[APK Scanner]   batch ${i + 1}/${nBatches}: +${added} new (total ${merged.length})`);
    }
    aiResult = { ...(base || {}), recommendedEvents: merged };
  }

  console.log(`[APK Scanner] ✓ ${aiResult.recommendedEvents.length} events for "${aiResult.businessVertical}"`);

  // Two-stage deterministic cleanup (critical when running on Groq):
  //  1. sanitizer — remove known off-vertical / filler events.
  //  2. evidence verifier — remove any event not grounded in real signals.
  const sanitized = sanitizeEvents(aiResult.recommendedEvents, {
    vertical:    aiResult.detectedVertical,
    permissions: signals.permissions,
  });
  const recommendedEvents = verifyEventsAgainstEvidence(sanitized, {
    signals, webHint, vertical: aiResult.detectedVertical,
  });

  return {
    // Standard shape (same as scanWebsite return) so frontend works unchanged
    url:                 `apk://${signals.packageName}`,
    pageTitle:           signals.appLabel,
    pagesScanned:        signals.activities.length,
    pageTypes:           signals.screenNames.slice(0, 10),
    detectedVertical:    aiResult.detectedVertical,
    verticalReasoning:   aiResult.verticalReasoning,
    businessVertical:    aiResult.businessVertical,
    businessDescription: aiResult.businessDescription,
    websiteType:         'Android Mobile Application',
    recommendedEvents,
    analyticsInsight:    aiResult.analyticsInsight,
    // APK-specific metadata (shown in UI)
    apkMeta: {
      appName:           signals.appLabel,
      packageName:       signals.packageName,
      fileName:          signals.apkFileName,
      screensDetected:   signals.screenNames.length,
      activitiesFound:   signals.activities.length,
      permissions:       signals.permissions.slice(0, 15),
      sdks:              signals.sdks.slice(0, 10),
      deepLinks:         signals.deepLinkSchemes.slice(0, 8),
      features:          signals.inferredFeatures,
      // Extraction-quality fields — let the UI flag low-confidence results
      // instead of pretending the scan was definitive.
      manifestParsed:    signals.manifestParsed,
      extractionQuality: Number((signals.extractionQuality || 0).toFixed(2)),
      lowConfidence:     signals.lowConfidence,
      ownActivityCount:  signals.ownActivityCount,
      ownActivityRatio:  Number((signals.ownActivityRatio || 0).toFixed(2)),
      framework:         signals.framework?.kind || 'native',
      frameworkLabel:    signals.framework?.label || 'Native Android',
      extractionWarning:
        // Cross-platform builds get a dedicated, more accurate warning. The
        // "low confidence" heuristic flags them too (own-activity ratio is
        // always low for RN/Flutter shells) but a generic "obfuscated"
        // message would mislead — the issue is architectural, not obfuscation.
        (signals.framework && signals.framework.kind !== 'native')
          ? `This is a ${signals.framework.label} app. Most UI text is compiled into native binaries (e.g. libapp.so for Flutter, JS bundles for React Native) that no APK parser can read. We're working from asset filenames + manifest. For best accuracy, fill in the optional "App name" and "Reference website URL" fields below.`
          : signals.lowConfidence
            ? (signals.ownActivityRatio < 0.15 && signals.activities.length >= 5
                ? 'Only library/SDK activities are visible (Facebook auth, Recaptcha, WebView, etc.) — the app\'s own classes appear to be obfuscated or hidden. Recommendations are based on generic signals only and may be inaccurate. Try a non-obfuscated build for a real classification.'
                : 'Could not reliably extract APK signals (manifest unreadable or build heavily obfuscated). Recommendations may be inaccurate.')
            : null,
    },
    scanSummary: {
      totalEventsRecommended: recommendedEvents.length,
      mustHave:    recommendedEvents.filter(e => e.priority === 'must-have').length,
      recommended: recommendedEvents.filter(e => e.priority === 'recommended').length,
      niceToHave:  recommendedEvents.filter(e => e.priority === 'nice-to-have').length,
      pagesScanned: signals.activities.length,
    },
    // Provenance: which trained apps influenced this recommendation, if any.
    // Empty array when the corpus has no above-threshold matches.
    basedOn: neighbors.map((n) => ({
      appName:  n.appName,
      vertical: n.vertical,
      score:    Number(n.score.toFixed(3)),
    })),
    // External context the LLM was given alongside the manifest signals. Lets
    // the UI show "Classified using Play Store category: Food & Drink".
    externalContext: {
      userAppName:      userAppName || null,
      userReferenceUrl: userReferenceUrl || null,
      playStore:        playStore ? {
        title:       playStore.title,
        developer:   playStore.developer,
        category:    playStore.category,
        description: playStore.description,
        url:         playStore.url,
      } : null,
      webHint:          webHint || null,
      mappedVertical:   externalVertical,
    },
  };
}

module.exports = { scanApk, extractApkSignals, buildApkPrompt };