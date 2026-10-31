'use strict';
// 다다 기록 v0.1 — 오프라인 현장 기록. 외부 전송 코드 없음(공유는 사용자가 공유 시트에서 직접 선택).
const APP_VERSION = '0.5.1';
const HASH_VERSION = 2; // content_hash 규칙 버전 (2: 사진 설명·촬영 시각 포함)
const TAGS = ['맛', '가격', '분위기', '주차', '팁', '확인 필요'];
const SCHEMA_VERSION = 1;
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dada-capture', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('records', { keyPath: 'id' });
      const p = d.createObjectStore('photos', { keyPath: 'id' });
      p.createIndex('byRecord', 'recordId');
      p.createIndex('bySha', 'sha256');
      d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장 취소됨'));
    out = fn(t);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getAll = (store, index, key) => tx([store], 'readonly', (t) => {
  const s = t.objectStore(store);
  const r = index ? s.index(index).getAll(key) : s.getAll();
  const box = {}; r.onsuccess = () => { box.v = r.result; }; return box;
}).then((b) => b.v);
const getOne = (store, key) => tx([store], 'readonly', (t) => {
  const r = t.objectStore(store).get(key); const box = {}; r.onsuccess = () => { box.v = r.result; }; return box;
}).then((b) => b.v);
const putRecord = (rec) => tx(['records'], 'readwrite', (t) => { t.objectStore('records').put(rec); });

/* ---------- 도구 ---------- */
function hex(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(buf) { return hex(await crypto.subtle.digest('SHA-256', buf)); }
function newId() { const d = new Date(); const r = new Uint8Array(3); crypto.getRandomValues(r);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${hex(r)}`; }
function safeName(s, max = 60) {
  let n = String(s || '').normalize('NFC').replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, '_').replace(/\.\.+/g, '.').trim();
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > max) { const ext = (n.match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0]; n = n.slice(0, max - ext.length) + ext; }
  return n || 'file';
}
function fmtMB(n) { return (n / 1048576).toFixed(1) + 'MB'; }
function localStr(iso) { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm(iso)}`; }
function nowISO() { return new Date().toISOString(); }
function hhmm(iso) { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function flash(text, kind = 'info') { $('flash').innerHTML = ''; const m = document.createElement('div'); m.className = 'msg ' + kind; m.textContent = text; $('flash').appendChild(m); m.scrollIntoView({ block: 'nearest' }); }

// 파일 앞부분으로 실제 형식 확인 (확장자보다 우선)
function detectKind(u8) {
  const s = (a, b) => String.fromCharCode(...u8.slice(a, b));
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return { kind: 'jpeg', ok: true };
  if (u8[0] === 0x89 && s(1, 4) === 'PNG') return { kind: 'png', ok: true };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { kind: 'webp', ok: true };
  if (s(0, 3) === 'GIF') return { kind: 'gif', ok: true };
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { kind: 'heic', ok: true };
    if (brand === 'qt  ') return { kind: 'mov', ok: true, note: '영상(Live Photo 영상 포함 가능)' };
    return { kind: 'video-' + brand.trim(), ok: true, note: '영상' };
  }
  return { kind: 'unknown', ok: false, note: '형식 확인 필요 — 원본 그대로 보관·내보내기' };
}

/* ---------- 사진 정보(EXIF): 촬영 시각·위치정보 유무. JPEG만 읽음 ---------- */
function readExif(u8) {
  const out = { takenAt: null, takenOffset: null, hasGps: false, read: false };
  try {
    if (!(u8[0] === 0xff && u8[1] === 0xd8)) return out;
    let i = 2;
    while (i + 4 < u8.length) {
      if (u8[i] !== 0xff) break;
      const m = u8[i + 1], len = (u8[i + 2] << 8) | u8[i + 3];
      if (m === 0xda || m === 0xd9) break;
      if (m === 0xe1 && String.fromCharCode(...u8.slice(i + 4, i + 8)) === 'Exif' && u8[i + 8] === 0 && u8[i + 9] === 0) {
        parseTiff(u8, i + 10, Math.min(u8.length, i + 2 + len), out); out.read = true; break;
      }
      i += 2 + len;
    }
  } catch (e) { /* 손상된 EXIF는 무시 — 사진 저장에는 영향 없음 */ }
  return out;
}
function parseTiff(u8, t, end, out) {
  const le = u8[t] === 0x49; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(t + o, le), u32 = (o) => dv.getUint32(t + o, le);
  const each = (off, cb) => { if (t + off + 2 > end) return 0; const n = u16(off); for (let k = 0; k < n; k++) { const e = off + 2 + k * 12; if (t + e + 12 > end) break; cb(u16(e), u32(e + 4), e + 8); } return n; };
  const ascii = (count, voff) => { const off = count > 4 ? u32(voff) : voff; let s = ''; for (let k = 0; k < count && t + off + k < end; k++) { const c = u8[t + off + k]; if (!c) break; s += String.fromCharCode(c); } return s; };
  let exifPtr = null, gpsPtr = null;
  each(u32(4), (tag, count, voff) => { if (tag === 0x8769) exifPtr = u32(voff); if (tag === 0x8825) gpsPtr = u32(voff); });
  if (exifPtr) each(exifPtr, (tag, count, voff) => {
    if (tag === 0x9003) { const m = ascii(count, voff).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/); if (m) out.takenAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`; }
    if (tag === 0x9011) out.takenOffset = ascii(count, voff) || null;
  });
  if (gpsPtr) out.hasGps = each(gpsPtr, () => {}) > 0;
}

/* ---------- 저장공간 ---------- */
async function storageCheck() {
  const box = $('storageMsg');
  if (!navigator.storage) { box.textContent = '이 브라우저는 저장공간 상태를 알려주지 않습니다. 기록 후 자주 내보내기를 하세요.'; box.classList.remove('hidden'); return; }
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist(); } catch (e) { /* 무시 */ }
  // 아이폰 Safari의 estimate() 사용량은 실제와 크게 다를 수 있어, 앱이 저장한 사진 크기를 직접 합산해 보여 줌
  let est = '';
  try {
    const [photos, recs] = await Promise.all([getAll('photos'), getAll('records')]);
    const trashIds = new Set(recs.filter((r) => r.trashedAt).map((r) => r.id));
    const total = photos.reduce((s, p) => s + p.size, 0);
    const inTrash = photos.filter((p) => trashIds.has(p.recordId)).reduce((s, p) => s + p.size, 0);
    est = ` 앱 안 사진 ${photos.length}장 · ${fmtMB(total)}${inTrash ? ` (휴지통 ${fmtMB(inTrash)} 포함 — 완전 삭제해야 공간이 비워짐)` : ''}`;
    const e = await navigator.storage.estimate();
    if (e.quota) est += ` · 기기 허용 한도 약 ${(e.quota / 1073741824).toFixed(1)}GB`;
  } catch (e) { /* 무시 */ }
  box.textContent = (persisted ? '영구 저장 허용됨.' : '영구 저장이 허용되지 않았습니다. 사이트 데이터 삭제 시 앱 안 기록이 사라질 수 있으니, 방문이 끝날 때마다 내보내기로 파일 사본을 남기세요.') + est;
  box.className = 'msg ' + (persisted ? 'ok' : 'err');
}
async function hasRoomFor(bytes) {
  try { const e = await navigator.storage.estimate(); if (e.quota && e.quota - e.usage < bytes * 1.2 + 5e6) return false; } catch (e) { /* 알 수 없으면 시도 */ }
  return true;
}

/* ---------- 상태 ---------- */
let current = null; // 현재 열린 기록
let lastBatch = []; // 방금 추가한 사진 id

// 내보내기 상태: 'empty' 내용 없음 / 'never' 아직 안 함 / 'changed' 내보낸 뒤 바뀜 / 'ok' 최신
const shortKind = (k) => ({ jpeg: 'JPG', heic: 'HEIC', png: 'PNG', webp: 'WEBP', gif: 'GIF', mov: 'MOV', unknown: '?' }[k] || k.toUpperCase().slice(0, 4));
function exportState(r, photoCount) {
  if (!photoCount && !r.notes.length) return { key: 'empty' };
  if (!r.exports.length) return { key: 'never', text: '아직 내보내지 않음', cls: 'warn' };
  const last = r.exports[r.exports.length - 1].at;
  if (r.updatedAt && r.updatedAt > last) return { key: 'changed', text: `내보낸 뒤 바뀜 (마지막 ${localStr(last)})`, cls: 'warn' };
  return { key: 'ok', text: `내보냄 ${localStr(last)}`, cls: 'ok' };
}

async function renderHome() {
  $('viewHome').classList.remove('hidden'); $('viewRecord').classList.add('hidden'); $('flash').innerHTML = '';
  const all = (await getAll('records')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recs = all.filter((r) => !r.trashedAt), trash = all.filter((r) => r.trashedAt);
  const ul = $('recordList'); ul.innerHTML = ''; const pending = [];
  if (!recs.length) { ul.innerHTML = '<li class="status">아직 기록이 없습니다.</li>'; }
  renderTrash(trash); renderDayCard(recs);
  for (const r of recs) {
    const photos = await getAll('photos', 'byRecord', r.id);
    const li = document.createElement('li');
    li.innerHTML = `<strong></strong><div class="status"></div>`;
    li.querySelector('strong').textContent = `${r.date} · ${r.place}`;
    li.querySelector('.status').textContent = `${r.topic || '주제 없음'} · 사진 ${photos.length}장 · 메모 ${r.notes.length}개 · ${r.endedAt ? '기록 끝' : '기록 중'}`;
    const st = exportState(r, photos.length);
    if (st.text) { const bd = document.createElement('span'); bd.className = 'badge ' + st.cls; bd.textContent = st.text; li.insertBefore(bd, li.querySelector('.status').nextSibling); }
    if (st.key === 'never' || st.key === 'changed') pending.push(r.place);
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '열기'; b.onclick = () => openRecord(r.id);
    li.appendChild(b); ul.appendChild(li);
  }
  const pb = $('pendingMsg');
  pb.classList.toggle('hidden', !pending.length);
  if (pending.length) pb.textContent = `내보내지 않은(또는 내보낸 뒤 바뀐) 기록 ${pending.length}개: ${pending.join(', ')}. 휴대폰 분실·고장에 대비해 기록을 열어 '내보내기 묶음 만들기' → '파일로 저장'을 해 두세요.`;
  try { localStorage.setItem('dada.open', ''); } catch (e) { /* 무시 */ }
}

async function renderTrash(trash) {
  const box = $('trashCard'), ul = $('trashList');
  box.classList.toggle('hidden', !trash.length); ul.innerHTML = '';
  for (const r of trash) {
    const photos = await getAll('photos', 'byRecord', r.id);
    const li = document.createElement('li');
    li.innerHTML = '<strong></strong><div class="status"></div><div class="row"></div>';
    li.querySelector('strong').textContent = `${r.date} · ${r.place}`;
    li.querySelector('.status').textContent = `사진 ${photos.length}장 · 메모 ${r.notes.length}개 · 휴지통으로 옮긴 시각 ${localStr(r.trashedAt)}${r.exports.length ? '' : ' · 한 번도 내보내지 않음'}`;
    const rb = document.createElement('button'); rb.className = 'secondary'; rb.textContent = '복구';
    rb.onclick = async () => { delete r.trashedAt; r.log.push({ type: 'restored', at: nowISO() }); await putRecord(r); flash(`'${r.place}' 기록을 복구했습니다.`, 'ok'); renderHome(); storageCheck(); };
    const db_ = document.createElement('button'); db_.className = 'danger'; db_.textContent = '완전 삭제';
    db_.onclick = () => purgeRecord(r, photos.length);
    li.querySelector('.row').append(rb, db_); ul.appendChild(li);
  }
}

async function purgeRecord(r, count) {
  const warn = r.exports.length ? '' : '\n\n주의: 이 기록은 한 번도 내보내지 않았습니다. 메모는 다른 곳에 사본이 없습니다.';
  if (!confirm(`'${r.date} ${r.place}' 기록을 완전히 지울까요?\n사진 ${count}장(앱 안 사본)과 메모 ${r.notes.length}개가 사라지며 되돌릴 수 없습니다.\n사진 앱의 원본 사진은 그대로입니다.${warn}`)) return;
  try {
    const photos = await getAll('photos', 'byRecord', r.id);
    await tx(['records', 'photos', 'blobs'], 'readwrite', (t) => {
      for (const p of photos) { t.objectStore('blobs').delete(p.id); t.objectStore('photos').delete(p.id); }
      t.objectStore('records').delete(r.id);
    });
    try { localStorage.removeItem('dada.draft.' + r.id); } catch (e) { /* 무시 */ }
    await renderHome(); storageCheck(); flash(`'${r.place}' 기록을 완전히 지웠습니다.`, 'ok');
  } catch (e) { flash('삭제하지 못했습니다(자료는 그대로입니다): ' + e.message, 'err'); }
}

async function trashRecord() {
  const r = current; const photos = await getAll('photos', 'byRecord', r.id);
  const lastExport = r.exports.length ? r.exports[r.exports.length - 1].at : null;
  const unexported = !lastExport ? '\n\n이 기록은 아직 내보내지 않았습니다.' : (r.updatedAt && r.updatedAt > lastExport ? '\n\n마지막 내보내기 뒤에 바뀐 내용이 있습니다.' : '');
  if (!confirm(`'${r.place}' 기록(사진 ${photos.length}장, 메모 ${r.notes.length}개)을 휴지통으로 옮길까요?\n휴지통에서 복구할 수 있습니다.${unexported}`)) return;
  r.trashedAt = nowISO(); r.log.push({ type: 'trashed', at: r.trashedAt });
  try { await putRecord(r); } catch (e) { delete r.trashedAt; flash('옮기지 못했습니다: ' + e.message, 'err'); return; }
  current = null; await renderHome(); storageCheck(); flash(`'${r.place}' 기록을 휴지통으로 옮겼습니다. 목록 아래 휴지통에서 복구할 수 있습니다.`, 'ok');
}

async function deletePhoto(p) {
  if (!confirm(`${String(p.seq).padStart(3, '0')}번 사진(${p.originalName}, ${fmtMB(p.size)})을 이 기록에서 지울까요?\n앱 안 사본만 지워지고 사진 앱의 원본은 그대로입니다.`)) return;
  try {
    await tx(['photos', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').delete(p.id); t.objectStore('photos').delete(p.id); });
  } catch (e) { flash('사진을 지우지 못했습니다: ' + e.message, 'err'); return; }
  for (const n of current.notes) n.photoIds = n.photoIds.filter((id) => id !== p.id);
  lastBatch = lastBatch.filter((id) => id !== p.id);
  current.log.push({ type: 'photo_removed', at: nowISO(), name: p.originalName, sha256: p.sha256, seq: p.seq });
  await touch(); flash(`${String(p.seq).padStart(3, '0')}번 사진을 지웠습니다.`, 'ok'); await renderRecord(); storageCheck();
}

async function deleteNote(n) {
  const short = n.text.length > 40 ? n.text.slice(0, 40) + '…' : n.text;
  if (!confirm(`이 메모를 지울까요?\n\n"${short}"\n\n되돌릴 수 없습니다.`)) return;
  const idx = current.notes.indexOf(n); current.notes.splice(idx, 1);
  current.log.push({ type: 'note_removed', at: nowISO(), note_id: n.id });
  try { await touch(); } catch (e) { current.notes.splice(idx, 0, n); current.log.pop(); flash('메모를 지우지 못했습니다: ' + e.message, 'err'); return; }
  flash('메모를 지웠습니다.', 'ok'); await renderRecord();
}

async function touch() { current.updatedAt = nowISO(); await putRecord(current); }

/* ---------- 하루 일정 요약 MD ---------- */
async function renderDayCard(recs) {
  const dates = [...new Set(recs.map((r) => r.date))].sort().reverse();
  $('dayCard').classList.toggle('hidden', !dates.length);
  const sel = $('daySel'); const keep = sel.value; sel.innerHTML = '';
  for (const d of dates) { const o = document.createElement('option'); o.value = d; o.textContent = `${d} (${recs.filter((r) => r.date === d).length}곳)`; sel.appendChild(o); }
  if (dates.includes(keep)) sel.value = keep;
}
function recordSpan(r, photos) {
  const shots = photos.map((p) => p.takenAt).filter(Boolean).sort();
  if (shots.length) return { start: shots[0].slice(11, 16), end: shots[shots.length - 1].slice(11, 16), basis: '사진 촬영 시각' };
  return { start: hhmm(r.createdAt), end: r.endedAt ? hhmm(r.endedAt) : '?', basis: '기록 시작·끝 시각' };
}
async function daySummaryMarkdown(date) {
  const recs = (await getAll('records')).filter((r) => !r.trashedAt && r.date === date);
  const items = [];
  for (const r of recs) { const photos = (await getAll('photos', 'byRecord', r.id)).sort((a, b) => a.seq - b.seq); items.push({ r, photos, span: recordSpan(r, photos) }); }
  items.sort((a, b) => a.span.start.localeCompare(b.span.start));
  const np = items.reduce((s, x) => s + x.photos.length, 0), nn = items.reduce((s, x) => s + x.r.notes.length, 0);
  const L = [`# 다다 하루 일정 — ${date}`, '', `- **방문**: ${items.length}곳 · **사진** ${np}장 · **메모** ${nn}개`, '',
    '> 메모와 사진 설명은 사용자가 현장에서 직접 쓴 내용입니다. 사진 원본은 각 기록의 내보내기 묶음(ZIP)에 있습니다.', '', '## 동선', ''];
  items.forEach((x, i) => L.push(`${i + 1}. **${x.span.start}~${x.span.end}** ${x.r.place}${x.r.topic ? ' — ' + x.r.topic : ''} (사진 ${x.photos.length}장)`));
  const pending = items.filter((x) => { const st = exportState(x.r, x.photos.length); return st.key === 'never' || st.key === 'changed'; });
  if (pending.length) L.push('', `> ⚠️ 아직 내보내지 않았거나 내보낸 뒤 바뀐 기록: ${pending.map((x) => x.r.place).join(', ')} — 사진 원본 묶음이 최신이 아닐 수 있습니다.`);
  const tagged = {};
  items.forEach((x, i) => {
    L.push('', `## ${i + 1}. ${x.r.place} (${x.span.start}~${x.span.end})`, '', `- 주제: ${x.r.topic || '(없음)'}`, `- 시간 기준: ${x.span.basis}`, `- 기록번호: ${x.r.id}`, '', '### 메모', '');
    if (!x.r.notes.length) L.push('(메모 없음)');
    x.r.notes.forEach((n) => { L.push(`- [${hhmm(n.at)}] ${n.text.replace(/\n/g, ' / ')}`); noteTags(n.text).forEach((t) => (tagged[t.tag] = tagged[t.tag] || []).push(`${t.text || '(내용 없음)'} — ${x.r.place}`)); });
    const caps = x.photos.filter((p) => p.caption);
    if (caps.length) { L.push('', '### 사진 설명', ''); caps.forEach((p) => L.push(`- ${String(p.seq).padStart(3, '0')}${p.takenAt ? ` (촬영 ${p.takenAt.slice(11, 16)})` : ''}: ${p.caption}`)); }
  });
  if (Object.keys(tagged).length) {
    L.push('', '## 꼬리표별 모음 (하루 전체)', '');
    for (const t of TAGS) if (tagged[t]) { L.push(`### ${t}${t === '확인 필요' ? ' (블로그에 쓰기 전 사실 확인)' : ''}`, ''); tagged[t].forEach((v) => L.push('- ' + v)); L.push(''); }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
async function makeDaySummary() {
  const date = $('daySel').value; if (!date) return;
  const out = $('dayOut'); out.innerHTML = '';
  try {
    const md = await daySummaryMarkdown(date);
    const f = new File([md], `다다_일정_${date}.md`, { type: 'text/markdown;charset=utf-8' });
    const m = document.createElement('div'); m.className = 'msg ok'; m.textContent = `${f.name} 준비됨 (${(f.size / 1024).toFixed(1)}KB). 사진은 들어 있지 않은 글 요약입니다.`; out.appendChild(m);
    const sh = document.createElement('button'); sh.textContent = '공유';
    sh.onclick = async () => {
      let ok = false; try { ok = !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch (e) { /* 무시 */ }
      if (!ok) { flash('이 기기에서는 공유 시트로 넘길 수 없습니다. "파일로 저장"을 쓰세요.', 'err'); return; }
      try { await navigator.share({ files: [f], title: f.name }); } catch (e) { if (e.name !== 'AbortError') flash('공유 실패: ' + e.message, 'err'); }
    };
    const a = document.createElement('a'); a.className = 'btn'; a.style.background = '#e9e1d1'; a.style.color = '#1d2522'; a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = '파일로 저장 (다운로드)';
    out.append(sh, a);
  } catch (e) { flash('요약을 만들지 못했습니다: ' + e.message, 'err'); }
}

async function startRecord() {
  const date = $('fDate').value, place = $('fPlace').value.trim(), topic = $('fTopic').value.trim();
  if (!date || !place) { flash('날짜와 장소를 입력하세요.', 'err'); return; }
  const rec = { id: newId(), schemaVersion: SCHEMA_VERSION, date, place, topic, createdAt: nowISO(), endedAt: null, notes: [], log: [], exports: [] };
  try { await putRecord(rec); } catch (e) { flash('기록을 저장하지 못했습니다: ' + e.message, 'err'); return; }
  $('fPlace').value = ''; $('fTopic').value = '';
  openRecord(rec.id);
}

async function openRecord(id) {
  $('flash').innerHTML = ''; $('exportOut').innerHTML = '';
  current = await getOne('records', id);
  if (!current || current.trashedAt) { current = null; return renderHome(); }
  lastBatch = []; endEditNote();
  try { localStorage.setItem('dada.open', id); } catch (e) { /* 무시 */ }
  $('viewHome').classList.add('hidden'); $('viewRecord').classList.remove('hidden'); $('pendingMsg').classList.add('hidden');
  await renderRecord();
}

async function renderRecord() {
  const r = current;
  const photos = (await getAll('photos', 'byRecord', r.id)).sort((a, b) => a.seq - b.seq);
  $('recTitle').textContent = `${r.place}${r.topic ? ' — ' + r.topic : ''}`;
  $('recMeta').textContent = `${r.date} · 기록번호 ${r.id}`;
  const total = photos.reduce((s, p) => s + p.size, 0);
  const odd = photos.filter((p) => !p.formatOk || p.kind.startsWith('video') || p.kind === 'mov');
  const cross = photos.filter((p) => p.alsoIn && p.alsoIn.length);
  $('recBadges').innerHTML = '';
  const badge = (t, k = '') => { const s = document.createElement('span'); s.className = 'badge ' + k; s.textContent = t; $('recBadges').appendChild(s); };
  badge(r.endedAt ? '기록 끝 ' + hhmm(r.endedAt) : '기록 중', r.endedAt ? 'ok' : '');
  badge(`사진 ${photos.length}장 · ${fmtMB(total)}`);
  badge(`메모 ${r.notes.length}개`);
  const dupTries = r.log.filter((l) => l.type === 'duplicate_skipped').length;
  if (dupTries) badge(`같은 사진 재선택 ${dupTries}회 (다시 저장 안 함)`, 'warn');
  if (cross.length) badge(`다른 기록에도 있는 사진 ${cross.length}장`, 'warn');
  if (odd.length) badge(`형식 확인 필요/영상 ${odd.length}개`, 'warn');
  { const st = exportState(r, photos.length); if (st.text) badge(st.text, st.cls); }
  $('photoCount').textContent = `(${photos.length})`;
  $('noteCount').textContent = `(${r.notes.length})`;
  $('noteLinkLabel').textContent = lastBatch.length ? `방금 추가한 사진 ${lastBatch.length}장과 연결` : '방금 추가한 사진과 연결 (추가한 사진 없음)';
  $('noteLink').disabled = !lastBatch.length; if (!lastBatch.length) $('noteLink').checked = false;

  const th = $('thumbs');
  th.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  th.innerHTML = '';
  for (const p of photos) {
    const d = document.createElement('div');
    d.title = p.originalName;
    if (['jpeg', 'png', 'webp', 'gif', 'heic'].includes(p.kind)) {
      const blob = await getOne('blobs', p.id);
      const img = document.createElement('img'); img.alt = p.originalName; img.loading = 'lazy';
      img.onerror = () => { img.remove(); d.prepend(document.createTextNode(`${String(p.seq).padStart(3, '0')} ${p.kind.toUpperCase()}`)); };
      if (blob) img.src = URL.createObjectURL(blob);
      d.appendChild(img);
    } else d.textContent = `${String(p.seq).padStart(3, '0')} ${p.kind}`;
    if (p.alsoIn && p.alsoIn.length) { const t = document.createElement('span'); t.className = 'dup'; t.textContent = '다른 기록에도 있음'; d.appendChild(t); }
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `${String(p.seq).padStart(3, '0')}${p.kind === 'jpeg' ? '' : ' ' + shortKind(p.kind)}`; d.appendChild(tag);
    if (p.hasGps) { const g = document.createElement('span'); g.className = 'gps'; g.textContent = '위치'; d.appendChild(g); }
    if (p.caption) { const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = p.caption; d.appendChild(cap); }
    d.onclick = (ev) => { if (ev.target.closest('.del')) return; editCaption(p); };
    const x = document.createElement('button'); x.className = 'del'; x.type = 'button'; x.setAttribute('aria-label', `${p.seq}번 사진 지우기`); x.textContent = '×';
    x.onclick = () => deletePhoto(p); d.appendChild(x);
    th.appendChild(d);
  }
  const cl = $('captionList'); cl.innerHTML = '';
  for (const p of photos) {
    const li = document.createElement('li');
    li.textContent = `${String(p.seq).padStart(3, '0')} · ${p.kind.toUpperCase()} · ${p.takenAt ? '촬영 ' + p.takenAt.slice(5, 16) : '촬영 시각 없음'}${p.hasGps ? ' · 위치정보 있음' : ''} — ${p.caption || '(설명 없음 · 사진을 눌러 추가)'}`;
    cl.appendChild(li);
  }
  const nl = $('noteList'); nl.innerHTML = '';
  for (const n of r.notes) {
    const li = document.createElement('li');
    const tx_ = document.createElement('div'); tx_.textContent = `[${hhmm(n.at)}] ${n.text}`; li.appendChild(tx_);
    if (n.photoIds.length) { const s = document.createElement('div'); s.className = 'status';
      s.textContent = '연결 사진: ' + n.photoIds.map((id) => { const p = photos.find((x) => x.id === id); return p ? String(p.seq).padStart(3, '0') : '?'; }).join(', '); li.appendChild(s); }
    if (n.editedAt) { const e = document.createElement('div'); e.className = 'status'; e.textContent = `고침 ${hhmm(n.editedAt)}`; li.appendChild(e); }
    const row = document.createElement('div'); row.className = 'note-actions';
    const ed = document.createElement('button'); ed.className = 'link-edit'; ed.type = 'button'; ed.textContent = '메모 고치기'; ed.onclick = () => startEditNote(n);
    const del = document.createElement('button'); del.className = 'link-del'; del.type = 'button'; del.textContent = '메모 지우기'; del.onclick = () => deleteNote(n);
    row.append(ed, del); li.appendChild(row);
    nl.appendChild(li);
  }
}

/* ---------- 사진 저장 ---------- */
async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!current) { flash(`기록이 아직 열리지 않아 사진 ${files.length}장을 저장하지 않았습니다. 기록을 연 뒤 다시 고르세요.`, 'err'); return; }
  const prog = $('progress');
  const existing = await getAll('photos', 'byRecord', current.id);
  let seq = existing.reduce((m, p) => Math.max(m, p.seq), 0);
  const saved = [], skipped = [], failed = [];
  lastBatch = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    prog.textContent = `${i + 1}/${files.length} 저장 중… ${f.name}`;
    try {
      if (!(await hasRoomFor(f.size))) throw new Error('저장공간 부족');
      const buf = await f.arrayBuffer();
      if (buf.byteLength !== f.size) throw new Error('파일을 끝까지 읽지 못함');
      const digest = await sha256(buf);
      const same = await getAll('photos', 'bySha', digest);
      const inThis = same.find((p) => p.recordId === current.id);
      if (inThis) { skipped.push(`${f.name} (=${String(inThis.seq).padStart(3, '0')}번)`); current.log.push({ type: 'duplicate_skipped', at: nowISO(), name: f.name, sha256: digest, same_as: inThis.id }); continue; }
      const det = detectKind(new Uint8Array(buf, 0, Math.min(32, buf.byteLength)));
      const ex = det.kind === 'jpeg' ? readExif(new Uint8Array(buf, 0, Math.min(262144, buf.byteLength))) : { takenAt: null, takenOffset: null, hasGps: false, read: false };
      const photo = {
        id: digest.slice(0, 16) + '-' + current.id, recordId: current.id, seq: ++seq,
        originalName: f.name || `photo_${seq}`, mime: f.type || '', size: buf.byteLength, sha256: digest,
        lastModified: f.lastModified ? new Date(f.lastModified).toISOString() : null,
        addedAt: nowISO(), kind: det.kind, formatOk: det.ok, formatNote: det.note || '',
        takenAt: ex.takenAt, takenOffset: ex.takenOffset, hasGps: ex.hasGps, exifRead: ex.read, caption: '',
        alsoIn: [...new Set(same.map((p) => p.recordId))],
      };
      const blob = new Blob([buf], { type: photo.mime || 'application/octet-stream' }); // File 참조가 아닌 실제 바이트 저장
      await tx(['photos', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').put(blob, photo.id); t.objectStore('photos').put(photo); });
      // 저장 확인: 다시 읽은 바이트의 SHA-256까지 같아야 완료 처리
      const back = await getOne('blobs', photo.id);
      let verified = !!back && back.size === photo.size;
      if (verified) verified = (await sha256(await back.arrayBuffer())) === digest;
      if (!verified) {
        await tx(['photos', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').delete(photo.id); t.objectStore('photos').delete(photo.id); });
        seq--; throw new Error('저장 확인 실패');
      }
      saved.push(photo); lastBatch.push(photo.id);
    } catch (e) {
      const msg = (e && e.name === 'QuotaExceededError') ? '저장공간 부족' : (e.message || String(e));
      failed.push(`${f.name}: ${msg}`); current.log.push({ type: 'save_failed', at: nowISO(), name: f.name, error: msg });
    }
  }
  if (saved.length) current.updatedAt = nowISO();
  try { await putRecord(current); } catch (e) { failed.push('기록 정보 갱신 실패: ' + e.message); }
  prog.textContent = '';
  let text = `저장됨 ${saved.length}장.`;
  if (skipped.length) text += ` 이미 있는 같은 사진이라 건너뜀 ${skipped.length}장: ${skipped.join(', ')}.`;
  if (failed.length) text += ` 저장 실패 ${failed.length}건(앱에 없음, 다시 시도 필요): ${failed.join(' / ')}`;
  const odd = saved.filter((p) => !p.formatOk || p.kind !== 'jpeg' && p.kind !== 'heic' && p.kind !== 'png');
  if (odd.length) text += ` 참고: ${odd.map((p) => `${p.originalName}=${p.kind}`).join(', ')}`;
  flash(text, failed.length ? 'err' : 'ok');
  await renderRecord(); storageCheck();
}

let editingNote = null;
function startEditNote(n) {
  editingNote = n; $('noteText').value = n.text; $('btnNote').textContent = '고친 메모 저장'; $('btnNoteCancel').classList.remove('hidden');
  $('noteCard').scrollIntoView({ block: 'start' }); $('noteText').focus();
}
function endEditNote() { editingNote = null; $('noteText').value = ''; $('btnNote').textContent = '메모 저장'; $('btnNoteCancel').classList.add('hidden'); }
async function editCaption(p) {
  const v = prompt(`${String(p.seq).padStart(3, '0')}번 사진 한 줄 설명 (예: 첨성대 정면, 해 질 무렵)`, p.caption || '');
  if (v === null) return;
  const old = p.caption; p.caption = v.trim().slice(0, 200);
  try { await tx(['photos'], 'readwrite', (t) => { t.objectStore('photos').put(p); }); await touch(); }
  catch (e) { p.caption = old; flash('설명을 저장하지 못했습니다: ' + e.message, 'err'); return; }
  flash(p.caption ? `${String(p.seq).padStart(3, '0')}번 사진 설명 저장됨.` : '설명을 지웠습니다.', 'ok'); await renderRecord();
}
function addTag(t) {
  const ta = $('noteText'); const v = ta.value;
  ta.value = v + (v && !v.endsWith('\n') ? '\n' : '') + `[${t}] `; ta.focus();
  try { if (current) localStorage.setItem('dada.draft.' + current.id, ta.value); } catch (e) { /* 무시 */ }
}

async function saveNote() {
  const text = $('noteText').value.trim();
  if (!text) { flash('메모 내용을 입력하세요.', 'err'); return; }
  if (editingNote) {
    const n = editingNote, oldText = n.text, oldEd = n.editedAt;
    if (text === oldText) { endEditNote(); return; }
    n.text = text; n.editedAt = nowISO(); current.updatedAt = n.editedAt;
    current.log.push({ type: 'note_edited', at: n.editedAt, note_id: n.id });
    try { await putRecord(current); } catch (e) { n.text = oldText; n.editedAt = oldEd; current.log.pop(); flash('고친 메모를 저장하지 못했습니다(입력 내용은 그대로 둡니다): ' + e.message, 'err'); return; }
    endEditNote(); try { localStorage.removeItem('dada.draft.' + current.id); } catch (e) { /* 무시 */ }
    flash('메모를 고쳤습니다.', 'ok'); await renderRecord(); return;
  }
  const note = { id: 'n' + Date.now().toString(36), at: nowISO(), text, photoIds: $('noteLink').checked ? [...lastBatch] : [] };
  current.notes.push(note); current.updatedAt = nowISO();
  try { await putRecord(current); } catch (e) { current.notes.pop(); flash('메모를 저장하지 못했습니다(입력 내용은 그대로 둡니다): ' + e.message, 'err'); return; }
  $('noteText').value = ''; $('noteLink').checked = false;
  try { localStorage.removeItem('dada.draft.' + current.id); } catch (e) { /* 무시 */ }
  flash('메모 저장됨.', 'ok');
  await renderRecord();
}

async function finishRecord() {
  if (current.endedAt) { flash('이미 끝난 기록입니다. 사진·메모는 계속 추가할 수 있습니다.', 'info'); return; }
  current.endedAt = nowISO(); current.updatedAt = current.endedAt;
  try { await putRecord(current); } catch (e) { current.endedAt = null; flash('저장 실패: ' + e.message, 'err'); return; }
  const photos = await getAll('photos', 'byRecord', current.id);
  flash(`기록 끝. 사진 ${photos.length}장, 메모 ${current.notes.length}개입니다. 내보내기 전에 개수를 확인하세요.`, 'ok');
  await renderRecord();
}

/* ---------- ZIP (무압축, 원본 바이트 그대로) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dosTime(d) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
function buildZip(entries) { // entries: {name, data: Blob|Uint8Array, crc, size}
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0; const dt = dosTime(new Date());
  for (const e of entries) {
    const name = enc.encode(e.name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt.time, true); h.setUint16(12, dt.date, true); h.setUint32(14, e.crc, true);
    h.setUint32(18, e.size, true); h.setUint32(22, e.size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, e.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt.time, true); c.setUint16(14, dt.date, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.size, true); c.setUint32(24, e.size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  if (offset + cdSize > 0xfffffff0) throw new Error('묶음이 4GB를 넘습니다. 나누기를 선택하세요.');
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ChatGPT 등에 첨부할 때 읽기 쉬운 Markdown 요약. 사진 내용 설명은 넣지 않음(사진을 보지 않았으므로)
function noteTags(text) { // [맛] 같은 꼬리표와 그 줄 내용
  const out = []; const re = /\[([^\]\n]{1,10})\]\s*([^\n]*)/g; let m;
  while ((m = re.exec(text))) if (TAGS.includes(m[1])) out.push({ tag: m[1], text: m[2].trim() });
  return out;
}
const takenStr = (p) => (p.takenAt ? p.takenAt.slice(0, 16) + (p.takenOffset ? ` (${p.takenOffset})` : '') : '-');

// ChatGPT 등에 첨부할 때 읽기 쉬운 Markdown 요약. 사진 내용은 사용자가 쓴 설명만 넣음(앱은 사진을 보지 않음)
function notesMarkdown(r, photos, fileOf, partOf = {}, parts = 1) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const total = photos.reduce((s, p) => s + p.size, 0);
  const L = [`# 다다 기록 — ${r.place}`, '',
    `- **날짜**: ${r.date}`, `- **장소**: ${r.place}`, `- **주제**: ${r.topic || '(없음)'}`,
    `- **기록 시간**: ${localStr(r.createdAt)} ~ ${r.endedAt ? localStr(r.endedAt) : '(기록 끝 누르지 않음)'}`,
    `- **사진**: ${photos.length}장 (${fmtMB(total)})${parts > 1 ? ` · 묶음 ${parts}개로 나뉨` : ''}`,
    `- **메모**: ${r.notes.length}개`, `- **기록번호**: ${r.id}`, '',
    '> 메모와 사진 설명은 사용자가 현장에서 직접 쓴 내용입니다. 그 밖의 사진 내용은 이 파일에 없습니다. 촬영 시각은 사진 파일에 기록된 값입니다.', ''];
  const gps = photos.filter((p) => p.hasGps);
  if (gps.length) L.push(`> ⚠️ 위치정보(GPS)가 들어 있는 사진 ${gps.length}장: 블로그에 올릴 때는 PC에서 만든 '위치 제거 사본'을 쓰세요. 원본은 보관용입니다.`, '');
  L.push('## 메모 (시간순)', '');
  if (!r.notes.length) L.push('(메모 없음)', '');
  r.notes.forEach((n, i) => {
    L.push(`### ${i + 1}. ${hhmm(n.at)}${n.editedAt ? ` (고침 ${hhmm(n.editedAt)})` : ''}`, '', n.text, '');
    const linked = n.photoIds.map((id) => fileOf[id]).filter(Boolean);
    if (linked.length) L.push('연결 사진: ' + linked.map((f) => '`' + f + '`').join(', '), '');
  });
  const tagged = {}; r.notes.forEach((n, i) => noteTags(n.text).forEach((t) => { (tagged[t.tag] = tagged[t.tag] || []).push(`${t.text || '(내용 없음)'} — 메모 ${i + 1}`); }));
  if (Object.keys(tagged).length) {
    L.push('## 꼬리표별 모음', '');
    for (const t of TAGS) if (tagged[t]) { L.push(`### ${t}${t === '확인 필요' ? ' (블로그에 쓰기 전 사실 확인)' : ''}`, ''); tagged[t].forEach((x) => L.push('- ' + x)); L.push(''); }
  }
  L.push('## 사진 목록', '', `| 번호 | 파일 | 형식 | 크기 | 촬영 시각 | 설명 | 연결 메모${parts > 1 ? ' | 묶음' : ''} |`, `|---|---|---|---|---|---|---${parts > 1 ? '|---' : ''}|`);
  for (const p of photos) {
    const ns = r.notes.map((n, i) => (n.photoIds.includes(p.id) ? i + 1 : null)).filter(Boolean);
    L.push(`| ${String(p.seq).padStart(3, '0')} | ${cell(fileOf[p.id])} | ${cell(p.kind.toUpperCase())}${p.formatOk ? '' : ' (확인 필요)'}${p.hasGps ? ' · 위치' : ''} | ${fmtMB(p.size)} | ${cell(takenStr(p))} | ${cell(p.caption || '-')} | ${ns.length ? ns.map((x) => '메모 ' + x).join(', ') : '-'}${parts > 1 ? ` | ${partOf[p.id] || '-'}` : ''} |`);
  }
  if (!photos.length) L.push('| - | (사진 없음) | | | | | |');
  const unlinked = photos.filter((p) => !r.notes.some((n) => n.photoIds.includes(p.id)) && !p.caption);
  if (photos.length) { L.push('', '## 메모·설명이 없는 사진', ''); L.push(unlinked.length ? unlinked.map((p) => '- `' + fileOf[p.id] + '`').join('\n') : '(없음 — 모든 사진에 메모나 설명이 있음)'); }
  return L.join('\n') + '\n';
}

function notesText(r, photos, fileOf) {
  const lines = ['다다 기록', `기록번호: ${r.id}`, `날짜: ${r.date}`, `장소: ${r.place}`, `주제: ${r.topic || ''}`,
    `시작: ${localStr(r.createdAt)}`, `끝: ${r.endedAt ? localStr(r.endedAt) : '(기록 끝 누르지 않음)'}`, `사진: ${photos.length}장`, ''];
  for (const n of r.notes) {
    lines.push(`[${hhmm(n.at)}] ${n.text}`);
    if (n.photoIds.length) lines.push('  연결 사진: ' + n.photoIds.map((id) => fileOf[id] || '(삭제됨)').join(', '));
  }
  if (!r.notes.length) lines.push('(메모 없음)');
  const caps = photos.filter((p) => p.caption);
  if (caps.length) { lines.push('', '사진 설명:'); caps.forEach((p) => lines.push(`  ${fileOf[p.id]}: ${p.caption}`)); }
  return lines.join('\n') + '\n';
}

async function exportRecord() {
  const out = $('exportOut'); out.innerHTML = '';
  const btn = $('btnExport'); btn.disabled = true;
  try {
    const r = current;
    const photos = (await getAll('photos', 'byRecord', r.id)).sort((a, b) => a.seq - b.seq);
    if (!photos.length && !r.notes.length) throw new Error('내보낼 사진과 메모가 없습니다.');
    const limit = Number($('splitSel').value) * 1048576;
    const base = safeName(`다다_${r.date}_${r.place}_${r.id}`, 80);
    const used = new Set(); const fileOf = {};
    for (const p of photos) {
      let n = `photos/${String(p.seq).padStart(3, '0')}_${safeName(p.originalName, 60)}`;
      while (used.has(n.toLowerCase())) n = n.replace(/(\.[^.]*)?$/, (m) => '_' + m);
      used.add(n.toLowerCase()); fileOf[p.id] = n;
    }
    const enc = new TextEncoder();
    const exportedAt = nowISO();
    const exportId = (crypto.randomUUID ? crypto.randomUUID() : hex(crypto.getRandomValues(new Uint8Array(16))));
    const notes = enc.encode(notesText(r, photos, fileOf));
    // 묶음 나누기: 사진 + ZIP 머리글 + notes/manifest 예상 크기까지 포함한 실제 ZIP 크기 기준 (사진 순서 유지)
    const entryCost = (p) => p.size + 76 + 2 * enc.encode(`${base}/${fileOf[p.id]}`).length;
    const fixedCost = 3 * notes.length + photos.length * 250 + enc.encode(JSON.stringify(r.log)).length * 2 + photos.length * 900 + 4096;
    const groups = [[]]; let acc = fixedCost;
    for (const p of photos) {
      if (limit && acc + entryCost(p) > limit && groups[groups.length - 1].length) { groups.push([]); acc = fixedCost; }
      groups[groups.length - 1].push(p); acc += entryCost(p);
    }
    const manifestPhotos = photos.map((p) => ({
      index: p.seq, file: fileOf[p.id], original_name: p.originalName, mime: p.mime, detected_format: p.kind,
      format_supported: p.formatOk, format_note: p.formatNote, size: p.size, sha256: p.sha256,
      last_modified: p.lastModified, added_at: p.addedAt, also_in_records: p.alsoIn || [],
      taken_at: p.takenAt || null, taken_offset: p.takenOffset || null, has_gps: !!p.hasGps, exif_read: !!p.exifRead, caption: p.caption || '',
      note_ids: r.notes.filter((n) => n.photoIds.includes(p.id)).map((n) => n.id),
      part: groups.findIndex((g) => g.includes(p)) + 1,
    }));
    const manifestNotes = r.notes.map((n) => ({ id: n.id, at: n.at, text: n.text, photo_files: n.photoIds.map((id) => fileOf[id]).filter(Boolean), edited_at: n.editedAt || null, tags: noteTags(n.text).map((t) => t.tag) }));
    // 전송 정보(exported_at, export_id, part)를 뺀 기록 본문 해시 — PC가 같은 규칙으로 다시 계산해 비교
    const body = {
      schema_version: SCHEMA_VERSION, record_id: r.id, date: r.date, place: r.place, topic: r.topic, started_at: r.createdAt, ended_at: r.endedAt,
      photos: manifestPhotos.map((p) => ({ index: p.index, file: p.file, original_name: p.original_name, mime: p.mime, detected_format: p.detected_format, format_supported: p.format_supported, size: p.size, sha256: p.sha256, caption: p.caption, taken_at: p.taken_at })),
      notes: manifestNotes.map((n) => ({ id: n.id, at: n.at, text: n.text, photo_files: n.photo_files })),
    };
    const contentHash = await sha256(enc.encode(JSON.stringify(body)));
    const notesHash = await sha256(notes);
    const partOf = {}; groups.forEach((g, gi) => g.forEach((p) => { partOf[p.id] = gi + 1; }));
    const md = enc.encode(notesMarkdown(r, photos, fileOf, partOf, groups.length));
    const mdHash = await sha256(md);
    const results = []; const oversize = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const entries = [];
      for (const p of groups[gi]) {
        $('progress').textContent = `${p.seq}/${photos.length} 확인 중…`;
        const blob = await getOne('blobs', p.id);
        if (!blob) throw new Error(`${fileOf[p.id]} 원본을 앱에서 찾지 못했습니다.`);
        const u8 = new Uint8Array(await blob.arrayBuffer());
        if (u8.length !== p.size || (await sha256(u8)) !== p.sha256) throw new Error(`${fileOf[p.id]} 확인값이 저장 당시와 다릅니다. 내보내기를 중단했고 앱 안 자료는 그대로입니다.`);
        entries.push({ name: `${base}/${fileOf[p.id]}`, data: blob, crc: crc32(u8), size: p.size });
      }
      const manifest = {
        schema_version: SCHEMA_VERSION, app: 'dada-capture', app_version: APP_VERSION, record_id: r.id,
        date: r.date, place: r.place, topic: r.topic, started_at: r.createdAt, ended_at: r.endedAt,
        time_basis: '*_at 값은 UTC(ISO 8601). date는 사용자가 입력한 방문일. last_modified는 파일 수정 시각이며 촬영일이 아닐 수 있음',
        export_id: exportId, exported_at: exportedAt, part: gi + 1, parts: groups.length,
        part_files: groups[gi].map((p) => fileOf[p.id]), part_bytes: groups[gi].reduce((s, p) => s + p.size, 0),
        photo_count: photos.length, total_bytes: photos.reduce((s, p) => s + p.size, 0),
        content_hash: contentHash, content_hash_version: HASH_VERSION, notes_sha256: notesHash, notes_md_file: '기록.md', notes_md_sha256: mdHash,
        photos: manifestPhotos, notes: manifestNotes,
        events: r.log, uploaded: false, published: false,
      };
      const mBytes = enc.encode(JSON.stringify(manifest, null, 2));
      entries.push({ name: `${base}/notes.txt`, data: notes, crc: crc32(notes), size: notes.length });
      entries.push({ name: `${base}/기록.md`, data: md, crc: crc32(md), size: md.length });
      entries.push({ name: `${base}/manifest.json`, data: mBytes, crc: crc32(mBytes), size: mBytes.length });
      const zip = buildZip(entries);
      const zname = groups.length > 1 ? `${base}_part${gi + 1}of${groups.length}.zip` : `${base}.zip`;
      results.push(new File([zip], zname, { type: 'application/zip' }));
      if (limit && zip.size > limit) oversize.push(`${zname} ${fmtMB(zip.size)} (사진 한 장이 한도보다 큼)`);
    }
    $('progress').textContent = '';
    r.exports.push({ at: exportedAt, parts: results.length, bytes: results.reduce((s, f) => s + f.size, 0) });
    await putRecord(r);
    showExport(results, photos, fileOf, oversize);
    await renderRecord();
  } catch (e) {
    $('progress').textContent = '';
    flash('내보내기 실패: ' + (e.message || e) + ' (앱 안 원본은 지우지 않았습니다)', 'err');
    current.log.push({ type: 'export_failed', at: nowISO(), error: String(e.message || e) });
    try { await putRecord(current); } catch (e2) { /* 무시 */ }
  } finally { btn.disabled = false; }
}

function showExport(files, photos, fileOf, oversize = []) {
  const out = $('exportOut'); out.innerHTML = '';
  const m = document.createElement('div'); m.className = 'msg ok';
  m.textContent = `묶음 ${files.length}개 준비됨 (사진 ${photos.length}장, 메모 ${current.notes.length}개, 합계 ${fmtMB(files.reduce((s, f) => s + f.size, 0))}). 아직 어디에도 보내지 않았습니다.`;
  out.appendChild(m);
  if (oversize.length) { const w = document.createElement('div'); w.className = 'msg err'; w.textContent = '선택한 크기보다 큰 묶음: ' + oversize.join(', ') + '. 이 묶음은 개별 공유를 쓰거나 그대로 시도하세요.'; out.appendChild(w); }
  // 내보내기 칸의 안내는 버튼 바로 위에 표시(화면 맨 위 안내는 스크롤하면 안 보임)
  const note = document.createElement('div'); note.className = 'msg hidden'; out.appendChild(note);
  const say = (text, kind = 'info') => { note.className = 'msg ' + kind; note.textContent = text; note.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  const needWifi = () => {
    if ($('wifiOk').checked) return false;
    say('먼저 위의 "Wi-Fi 연결을 직접 확인했습니다"를 체크한 뒤 다시 누르세요.', 'err');
    const lab = $('wifiOk').closest('label'); lab.classList.add('attention'); lab.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => lab.classList.remove('attention'), 2500); return true;
  };
  const canShare = (fs) => { try { return !!(navigator.canShare && navigator.canShare({ files: fs })); } catch (e) { return false; } };
  files.forEach((f) => {
    const row = document.createElement('div');
    const share = document.createElement('button'); share.textContent = `공유: ${f.name} (${fmtMB(f.size)})`;
    share.onclick = async () => {
      if (needWifi()) return;
      if (!canShare([f])) { say('이 기기에서는 공유 시트로 이 파일을 넘길 수 없습니다. "파일로 저장"을 쓰세요.', 'err'); return; }
      try { await navigator.share({ files: [f], title: f.name }); share.textContent = `✓ 공유함: ${f.name} (${fmtMB(f.size)})`; share.classList.add('done'); say(`${f.name}을(를) 공유 시트로 넘겼습니다. 저장·첨부가 끝났는지는 받는 앱(파일 앱 등)에서 확인하세요.${files.length > 1 ? ` 묶음 ${files.length}개를 모두 보내야 합니다.` : ''}`, 'ok'); }
      catch (e) { say(e.name === 'AbortError' ? '공유를 취소했습니다. 묶음과 원본은 그대로입니다.' : '공유 실패: ' + e.message + ' — 다시 시도하거나 파일로 저장하세요.', 'err'); }
    };
    const a = document.createElement('a'); a.className = 'btn'; a.style.background = '#e9e1d1'; a.style.color = '#1d2522';
    a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = '파일로 저장 (다운로드)';
    row.append(share, a); out.appendChild(row);
  });
  // 큰 묶음이 실패할 때를 위한 개별 공유 경로
  const ind = document.createElement('button'); ind.className = 'secondary'; ind.textContent = '사진 원본 + 기록.md 개별 공유';
  ind.onclick = async () => {
    if (needWifi()) return;
    const list = [];
    for (const p of photos) { const b = await getOne('blobs', p.id); list.push(new File([b], fileOf[p.id].replace('photos/', ''), { type: p.mime || 'application/octet-stream' })); }
    list.push(new File([notesMarkdown(current, photos, fileOf)], '기록.md', { type: 'text/markdown;charset=utf-8' }));
    if (!canShare(list)) { say('한 번에 공유할 수 없는 크기·형식입니다. 묶음별 공유 버튼을 쓰세요.', 'err'); return; }
    try { await navigator.share({ files: list }); say('공유 시트로 넘겼습니다.', 'ok'); } catch (e) { say(e.name === 'AbortError' ? '공유 취소. 원본은 그대로입니다.' : '공유 실패: ' + e.message, 'err'); }
  };
  out.appendChild(ind);
}

/* ---------- 시작 ---------- */
function netState() { $('netState').textContent = navigator.onLine ? '온라인' : '오프라인'; }
async function init() {
  $('fDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('btnStart').onclick = startRecord;
  $('inPick').onchange = (e) => { addFiles(e.target.files).finally(() => { e.target.value = ''; }); };
  $('inShoot').onchange = (e) => { addFiles(e.target.files).finally(() => { e.target.value = ''; }); };
  $('btnNote').onclick = saveNote;
  $('btnFinish').onclick = finishRecord;
  $('btnExport').onclick = exportRecord;
  $('btnBack').onclick = () => { current = null; renderHome(); };
  $('btnTrash').onclick = trashRecord;
  $('btnNoteCancel').onclick = endEditNote;
  $('btnDay').onclick = makeDaySummary;
  const chips = $('tagChips'); TAGS.forEach((t) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = t; b.onclick = () => addTag(t); chips.appendChild(b); });
  $('appVersion').textContent = 'v' + APP_VERSION;
  // 메모 입력 중 앱이 닫혀도 초안 유지
  $('noteText').oninput = () => { try { if (current) localStorage.setItem('dada.draft.' + current.id, $('noteText').value); } catch (e) { /* 무시 */ } };
  window.addEventListener('online', netState); window.addEventListener('offline', netState); netState();
  try { db = await openDB(); } catch (e) { flash('앱 저장소를 열 수 없습니다(개인정보 보호 모드인지 확인): ' + e.message, 'err'); return; }
  storageCheck();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => flash('오프라인 실행 준비 실패: ' + e.message, 'err'));
    // 새 버전이 설치되면 알림. 저장 중일 수 있으므로 자동 새로고침하지 않고 사용자가 누르게 함
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const b = $('updateBar'); b.classList.remove('hidden');
    });
  }
  let openId = ''; try { openId = localStorage.getItem('dada.open') || ''; } catch (e) { /* 무시 */ }
  if (openId) { await openRecord(openId); try { const d = localStorage.getItem('dada.draft.' + openId); if (d) $('noteText').value = d; } catch (e) { /* 무시 */ } }
  else await renderHome();
  window.__dadaReady = true;
}
init();
