// 거래 영수증 파일(0230) — 순수 규칙 테스트. DB 불필요: node --test test/txn_files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTxnFileDataUrl, cleanFileName, txnVisibleTo, canAttachTxnFile, canDeleteTxnFile, TXN_FILE_MAX_BYTES } from '../src/txnFiles.js';

const b64 = (s) => Buffer.from(s).toString('base64');

test('형식: 사진·PDF·CFDI XML 허용, 그 밖은 거부', () => {
  assert.equal(validateTxnFileDataUrl('data:image/jpeg;base64,' + b64('jpg')).ok, true);
  assert.equal(validateTxnFileDataUrl('data:image/heic;base64,' + b64('heic')).ok, true);
  assert.equal(validateTxnFileDataUrl('data:application/pdf;base64,' + b64('%PDF')).mime, 'application/pdf');
  assert.equal(validateTxnFileDataUrl('data:text/xml;base64,' + b64('<x/>')).ok, true);
  assert.equal(validateTxnFileDataUrl('data:application/xml;base64,' + b64('<x/>')).ok, true);
  assert.equal(validateTxnFileDataUrl('data:application/vnd.ms-excel;base64,' + b64('x')).error, 'bad_mime');
  assert.equal(validateTxnFileDataUrl('data:application/octet-stream;base64,' + b64('x')).error, 'bad_mime');
  assert.equal(validateTxnFileDataUrl('hello').error, 'bad_format');
  assert.equal(validateTxnFileDataUrl('').error, 'empty');
  assert.equal(validateTxnFileDataUrl(null).error, 'empty');
});
test('크기: 실제 바이트(패딩 제외) · 8MB 초과 거부', () => {
  assert.equal(validateTxnFileDataUrl('data:image/png;base64,' + b64('abcd')).bytes, 4);
  assert.equal(validateTxnFileDataUrl('data:image/png;base64,' + b64('abcde')).bytes, 5);
  const ok = 'data:image/png;base64,' + Buffer.alloc(TXN_FILE_MAX_BYTES).toString('base64');
  assert.equal(validateTxnFileDataUrl(ok).ok, true);
  const big = 'data:image/png;base64,' + Buffer.alloc(TXN_FILE_MAX_BYTES + 1).toString('base64');
  assert.equal(validateTxnFileDataUrl(big).error, 'too_large');
});
test('파일명 정리: 경로 제거 · 제어문자 제거 · 120자(확장자 보존)', () => {
  assert.equal(cleanFileName('C:\\fotos\\ticket.png'), 'ticket.png');
  assert.equal(cleanFileName('/tmp/a/b.pdf'), 'b.pdf');
  assert.equal(cleanFileName('  \u0001 '), null);
  assert.equal(cleanFileName(null), null);
  const long = cleanFileName('x'.repeat(300) + '.pdf');
  assert.equal(long.length, 120); assert.ok(long.endsWith('.pdf'));
});
test('가시성: 거래목록과 같은 규칙', () => {
  const dir = { role: 'director', userId: 1 }, fin = { role: 'finance', userId: 2 };
  const all = { allow: null, block: [] };
  assert.equal(txnVisibleTo(dir, { account_id: 5, is_private: true }, all), true);
  assert.equal(txnVisibleTo(fin, { account_id: 5 }, { allow: [1], block: [] }), false);
  assert.equal(txnVisibleTo(fin, { account_id: 1 }, { allow: [1], block: [] }), true);
  assert.equal(txnVisibleTo(fin, { account_id: null }, { allow: [], block: [] }), true);
  assert.equal(txnVisibleTo(fin, { account_id: 1, is_private: true }, { allow: [1], block: [] }), false);
  assert.equal(txnVisibleTo(dir, { account_id: 7 }, { allow: null, block: [7] }), false);
});
test('첨부 권한: 디렉터 · 등록자 · 운영권한자 · 계좌 미지정', () => {
  const u = { role: 'finance', userId: 2 };
  assert.equal(canAttachTxnFile(u, { account_id: 1, created_by: 9 }, { visible: false, canOperate: true }), false);
  assert.equal(canAttachTxnFile({ role: 'director', userId: 1 }, { account_id: 1 }, { visible: true, canOperate: false }), true);
  assert.equal(canAttachTxnFile(u, { account_id: 1, created_by: '2' }, { visible: true, canOperate: false }), true);
  assert.equal(canAttachTxnFile(u, { account_id: 1, created_by: 9 }, { visible: true, canOperate: true }), true);
  assert.equal(canAttachTxnFile(u, { account_id: 1, created_by: 9 }, { visible: true, canOperate: false }), false);
  assert.equal(canAttachTxnFile(u, { account_id: null, created_by: 9 }, { visible: true, canOperate: false }), true);
});
test('삭제 권한: 디렉터 또는 올린 본인', () => {
  assert.equal(canDeleteTxnFile({ role: 'director', userId: 1 }, { uploaded_by: 5 }), true);
  assert.equal(canDeleteTxnFile({ role: 'finance', userId: 5 }, { uploaded_by: '5' }), true);
  assert.equal(canDeleteTxnFile({ role: 'finance', userId: 6 }, { uploaded_by: 5 }), false);
  assert.equal(canDeleteTxnFile({ role: 'finance', userId: 6 }, { uploaded_by: null }), false);
});
