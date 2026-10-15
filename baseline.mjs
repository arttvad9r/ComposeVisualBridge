import { readFileSync } from 'node:fs';
export const BRIDGE_VERSION=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
import { createHash } from 'node:crypto';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicSession(state) {
  const { reference, ...session } = state;
  return { ...session, bridgeVersion:BRIDGE_VERSION, baselineFingerprint: fingerprint(state.baseline), reference: reference ? {label:reference.label, mime:reference.mime, digest:reference.digest, capturedAt:reference.capturedAt} : null, verification: isVerified(state) ? state.verification : null };
}
export function readReference(input) {
  if (!['image/png','image/jpeg','image/webp'].includes(input.mime) || typeof input.image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw Error('Нужен снимок PNG, JPEG или WebP');
  const bytes = Buffer.from(input.image,'base64');
  const valid = input.mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : input.mime === 'image/jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255 : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if (!valid || bytes.length > 8_000_000 || bytes.length < 24) throw Error('Некорректный снимок или размер больше 8 MB');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 500) throw Error('Укажите экран, состояние и устройство эталона (до 500 символов)');
  return { mime:input.mime, image:bytes.toString('base64'), digest:createHash('sha256').update(bytes).digest('hex'), label:input.label.trim(), capturedAt:new Date().toISOString() };
}
export function isVerified(state) {
  // Rendering produces the reference, not proof that the browser reconstruction matches it.
  // Legacy render confirmations remain on disk but no longer authorize a new handoff.
  return !!state.reference && state.verification?.baselineFingerprint === fingerprint(state.baseline) && state.verification?.referenceDigest === state.reference.digest && state.verification?.confirmedBy === 'user' && state.verification?.bridgeVersion === BRIDGE_VERSION;
}
export function confirmBaseline(state,input) {
  if (!state.reference) throw Error('Сначала загрузите снимок настоящего экрана');
  if (input.acknowledged !== true || input.baselineFingerprint !== fingerprint(state.baseline)) throw Error('Подтвердите совпадение текущего исходного макета с эталоном');
  if (!state.baseline.sourceRevision || state.baseline.sourceRevision === 'demo-only') throw Error('У исходного макета нет проверяемой версии исходников');
  return { bridgeVersion:BRIDGE_VERSION, baselineFingerprint:fingerprint(state.baseline), referenceDigest:state.reference.digest, confirmedAt:new Date().toISOString(), confirmedBy:'user', sourceRevision:state.baseline.sourceRevision, viewport:state.baseline.viewport, state:state.baseline.state || null };
}
