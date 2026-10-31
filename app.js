'use strict';
// 다다 기록 v0.1 — 오프라인 현장 기록. 외부 전송 코드 없음(공유는 사용자가 공유 시트에서 직접 선택).
const APP_VERSION = '0.3.0';
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

/* ---------- 저장공간 ---------- */
async function storageCheck() {
  const box = $('storageMsg');
  if (!navigator.storage) { box.textContent = '이 브라우저는 저장공간 상태를 알려주지 않습니다. 기록 후 자주 내보내기를 하세요.'; box.classList.remove('hidden'); return; }
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist(); } catch (e) { /* 무시 */ }
  let est = '';
  try { const e = await navigator.storage.estimate(); est = ` 사용 ${fmtMB(e.usage || 0)} / 허용 약 ${fmtMB(e.quota || 0)}`; } catch (e) { /* 무시 */ }
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

async function renderHome() {
  $('viewHome').classList.remove('hidden'); $('viewRecord').classList.add('hidden'); $('flash').innerHTML = '';
  const all = (await getAll('records')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recs = all.filter((r) => !r.trashedAt), trash = all.filter((r) => r.trashedAt);
  const ul = $('recordList'); ul.innerHTML = '';
  if (!recs.length) { ul.innerHTML = '<li class="status">아직 기록이 없습니다.</li>'; }
  renderTrash(trash);
  for (const r of recs) {
    const photos = await getAll('photos', 'byRecord', r.id);
    const li = document.createElement('li');
    li.innerHTML = `<strong></strong><div class="status"></div>`;
    li.querySelector('strong').textContent = `${r.date} · ${r.place}`;
    li.querySelector('.status').textContent = `${r.topic || '주제 없음'} · 사진 ${photos.length}장 · 메모 ${r.notes.length}개 · ${r.endedAt ? '기록 끝' : '기록 중'}${r.exports.length ? ' · 내보냄 ' + r.exports.length + '회' : ''}`;
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '열기'; b.onclick = () => openRecord(r.id);
    li.appendChild(b); ul.appendChild(li);
  }
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
    rb.onclick = async () => { delete r.trashedAt; r.log.push({ type: 'restored', at: nowISO() }); await putRecord(r); flash(`'${r.place}' 기록을 복구했습니다.`, 'ok'); renderHome(); };
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
    await renderHome(); flash(`'${r.place}' 기록을 완전히 지웠습니다.`, 'ok');
  } catch (e) { flash('삭제하지 못했습니다(자료는 그대로입니다): ' + e.message, 'err'); }
}

async function trashRecord() {
  const r = current; const photos = await getAll('photos', 'byRecord', r.id);
  const lastExport = r.exports.length ? r.exports[r.exports.length - 1].at : null;
  const unexported = !lastExport ? '\n\n이 기록은 아직 내보내지 않았습니다.' : (r.updatedAt && r.updatedAt > lastExport ? '\n\n마지막 내보내기 뒤에 바뀐 내용이 있습니다.' : '');
  if (!confirm(`'${r.place}' 기록(사진 ${photos.length}장, 메모 ${r.notes.length}개)을 휴지통으로 옮길까요?\n휴지통에서 복구할 수 있습니다.${unexported}`)) return;
  r.trashedAt = nowISO(); r.log.push({ type: 'trashed', at: r.trashedAt });
  try { await putRecord(r); } catch (e) { delete r.trashedAt; flash('옮기지 못했습니다: ' + e.message, 'err'); return; }
  current = null; await renderHome(); flash(`'${r.place}' 기록을 휴지통으로 옮겼습니다. 목록 아래 휴지통에서 복구할 수 있습니다.`, 'ok');
}

async function deletePhoto(p) {
  if (!confirm(`${String(p.seq).padStart(3, '0')}번 사진(${p.originalName}, ${fmtMB(p.size)})을 이 기록에서 지울까요?\n앱 안 사본만 지워지고 사진 앱의 원본은 그대로입니다.`)) return;
  try {
    await tx(['photos', 'blobs'], 'readwrite', (t) => { t.objectStore('blobs').delete(p.id); t.objectStore('photos').delete(p.id); });
  } catch (e) { flash('사진을 지우지 못했습니다: ' + e.message, 'err'); return; }
  for (const n of current.notes) n.photoIds = n.photoIds.filter((id) => id !== p.id);
  lastBatch = lastBatch.filter((id) => id !== p.id);
  current.log.push({ type: 'photo_removed', at: nowISO(), name: p.originalName, sha256: p.sha256, seq: p.seq });
  await touch(); flash(`${String(p.seq).padStart(3, '0')}번 사진을 지웠습니다.`, 'ok'); await renderRecord();
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
  lastBatch = [];
  try { localStorage.setItem('dada.open', id); } catch (e) { /* 무시 */ }
  $('viewHome').classList.add('hidden'); $('viewRecord').classList.remove('hidden');
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
  if (r.exports.length) badge(`마지막 내보내기 ${hhmm(r.exports[r.exports.length - 1].at)}`, 'ok');
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
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `${String(p.seq).padStart(3, '0')} ${p.kind.toUpperCase()}`; d.appendChild(tag);
    const x = document.createElement('button'); x.className = 'del'; x.type = 'button'; x.setAttribute('aria-label', `${p.seq}번 사진 지우기`); x.textContent = '×';
    x.onclick = () => deletePhoto(p); d.appendChild(x);
    th.appendChild(d);
  }
  const nl = $('noteList'); nl.innerHTML = '';
  for (const n of r.notes) {
    const li = document.createElement('li');
    li.textContent = `[${hhmm(n.at)}] ${n.text}`;
    if (n.photoIds.length) { const s = document.createElement('div'); s.className = 'status';
      s.textContent = '연결 사진: ' + n.photoIds.map((id) => { const p = photos.find((x) => x.id === id); return p ? String(p.seq).padStart(3, '0') : '?'; }).join(', '); li.appendChild(s); }
    const del = document.createElement('button'); del.className = 'link-del'; del.type = 'button'; del.textContent = '메모 지우기'; del.onclick = () => deleteNote(n); li.appendChild(del);
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
      const photo = {
        id: digest.slice(0, 16) + '-' + current.id, recordId: current.id, seq: ++seq,
        originalName: f.name || `photo_${seq}`, mime: f.type || '', size: buf.byteLength, sha256: digest,
        lastModified: f.lastModified ? new Date(f.lastModified).toISOString() : null,
        addedAt: nowISO(), kind: det.kind, formatOk: det.ok, formatNote: det.note || '',
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
  await renderRecord();
}

async function saveNote() {
  const text = $('noteText').value.trim();
  if (!text) { flash('메모 내용을 입력하세요.', 'err'); return; }
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
  current.endedAt = nowISO();
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

function notesText(r, photos, fileOf) {
  const lines = ['다다 기록', `기록번호: ${r.id}`, `날짜: ${r.date}`, `장소: ${r.place}`, `주제: ${r.topic || ''}`,
    `시작: ${localStr(r.createdAt)}`, `끝: ${r.endedAt ? localStr(r.endedAt) : '(기록 끝 누르지 않음)'}`, `사진: ${photos.length}장`, ''];
  for (const n of r.notes) {
    lines.push(`[${hhmm(n.at)}] ${n.text}`);
    if (n.photoIds.length) lines.push('  연결 사진: ' + n.photoIds.map((id) => fileOf[id] || '(삭제됨)').join(', '));
  }
  if (!r.notes.length) lines.push('(메모 없음)');
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
    const fixedCost = 2 * notes.length + enc.encode(JSON.stringify(r.log)).length * 2 + photos.length * 900 + 4096;
    const groups = [[]]; let acc = fixedCost;
    for (const p of photos) {
      if (limit && acc + entryCost(p) > limit && groups[groups.length - 1].length) { groups.push([]); acc = fixedCost; }
      groups[groups.length - 1].push(p); acc += entryCost(p);
    }
    const manifestPhotos = photos.map((p) => ({
      index: p.seq, file: fileOf[p.id], original_name: p.originalName, mime: p.mime, detected_format: p.kind,
      format_supported: p.formatOk, format_note: p.formatNote, size: p.size, sha256: p.sha256,
      last_modified: p.lastModified, added_at: p.addedAt, also_in_records: p.alsoIn || [],
      note_ids: r.notes.filter((n) => n.photoIds.includes(p.id)).map((n) => n.id),
      part: groups.findIndex((g) => g.includes(p)) + 1,
    }));
    const manifestNotes = r.notes.map((n) => ({ id: n.id, at: n.at, text: n.text, photo_files: n.photoIds.map((id) => fileOf[id]).filter(Boolean) }));
    // 전송 정보(exported_at, export_id, part)를 뺀 기록 본문 해시 — PC가 같은 규칙으로 다시 계산해 비교
    const body = {
      schema_version: SCHEMA_VERSION, record_id: r.id, date: r.date, place: r.place, topic: r.topic, started_at: r.createdAt, ended_at: r.endedAt,
      photos: manifestPhotos.map((p) => ({ index: p.index, file: p.file, original_name: p.original_name, mime: p.mime, detected_format: p.detected_format, format_supported: p.format_supported, size: p.size, sha256: p.sha256 })),
      notes: manifestNotes.map((n) => ({ id: n.id, at: n.at, text: n.text, photo_files: n.photo_files })),
    };
    const contentHash = await sha256(enc.encode(JSON.stringify(body)));
    const notesHash = await sha256(notes);
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
        content_hash: contentHash, notes_sha256: notesHash,
        photos: manifestPhotos, notes: manifestNotes,
        events: r.log, uploaded: false, published: false,
      };
      const mBytes = enc.encode(JSON.stringify(manifest, null, 2));
      entries.push({ name: `${base}/notes.txt`, data: notes, crc: crc32(notes), size: notes.length });
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
  const canShare = (fs) => { try { return !!(navigator.canShare && navigator.canShare({ files: fs })); } catch (e) { return false; } };
  files.forEach((f) => {
    const row = document.createElement('div');
    const share = document.createElement('button'); share.textContent = `공유: ${f.name} (${fmtMB(f.size)})`;
    share.onclick = async () => {
      if (!$('wifiOk').checked) { flash('먼저 Wi-Fi 연결을 직접 확인하고 체크하세요.', 'err'); return; }
      if (!canShare([f])) { flash('이 기기에서는 공유 시트로 이 파일을 넘길 수 없습니다. 아래 "파일로 저장"을 쓰세요.', 'err'); return; }
      try { await navigator.share({ files: [f], title: f.name }); flash('공유 시트로 넘겼습니다. 받는 앱에서 첨부·업로드가 끝났는지는 그 앱에서 확인하세요.', 'info'); }
      catch (e) { flash(e.name === 'AbortError' ? '공유를 취소했습니다. 묶음과 원본은 그대로입니다.' : '공유 실패: ' + e.message + ' — 다시 시도하거나 파일로 저장하세요.', 'err'); }
    };
    const a = document.createElement('a'); a.className = 'btn'; a.style.background = '#e9e1d1'; a.style.color = '#1d2522';
    a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = '파일로 저장 (다운로드)';
    row.append(share, a); out.appendChild(row);
  });
  // 큰 묶음이 실패할 때를 위한 개별 공유 경로
  const ind = document.createElement('button'); ind.className = 'secondary'; ind.textContent = '사진 원본 + notes.txt 개별 공유';
  ind.onclick = async () => {
    if (!$('wifiOk').checked) { flash('먼저 Wi-Fi 연결을 직접 확인하고 체크하세요.', 'err'); return; }
    const list = [];
    for (const p of photos) { const b = await getOne('blobs', p.id); list.push(new File([b], fileOf[p.id].replace('photos/', ''), { type: p.mime || 'application/octet-stream' })); }
    list.push(new File([notesText(current, photos, fileOf)], 'notes.txt', { type: 'text/plain;charset=utf-8' }));
    if (!canShare(list)) { flash('한 번에 공유할 수 없는 크기·형식입니다. 묶음 나누기(50MB)를 선택하세요.', 'err'); return; }
    try { await navigator.share({ files: list }); } catch (e) { flash(e.name === 'AbortError' ? '공유 취소. 원본은 그대로입니다.' : '공유 실패: ' + e.message, 'err'); }
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
