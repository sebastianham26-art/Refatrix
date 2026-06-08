import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// PIN/비밀번호 해시: Node 내장 scrypt (네이티브 의존성 없음)
// 저장 형식: "salt(hex):hash(hex)"
export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(pin), salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// 기기 등록 키 해시 (단방향). 클라이언트가 보낸 원본 등록 키는 저장하지 않음.
export function hashDeviceKey(rawKey) {
  return createHash('sha256').update(String(rawKey)).digest('hex');
}
