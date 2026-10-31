import { createHmac, timingSafeEqual } from 'node:crypto';
export function verifyTelegram(raw, token, now = Date.now()) {
  if (!token || !raw || raw.length > 12000) throw new Error('Откройте магазин через Telegram-бота');
  const p = new URLSearchParams(raw);
  if ([...new Set(p.keys())].some(k => p.getAll(k).length !== 1)) throw new Error('Некорректные данные входа');
  const hash = p.get('hash'); p.delete('hash');
  const ts = Number(p.get('auth_date'));
  if (!Number.isInteger(ts) || ts > now / 1000 + 30 || now / 1000 - ts > 3600) throw new Error('Сеанс истёк. Откройте приложение заново');
  const data = [...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = createHmac('sha256','WebAppData').update(token).digest();
  const expected = createHmac('sha256',secret).update(data).digest();
  if (!/^[a-f0-9]{64}$/i.test(hash || '') || !timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw new Error('Подпись Telegram не подтверждена');
  const user = JSON.parse(p.get('user') || '{}');
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Неизвестный пользователь');
  return user;
}
