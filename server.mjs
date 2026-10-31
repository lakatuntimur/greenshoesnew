import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyTelegram} from './auth.mjs';
import {demoProducts} from './public/seed.js';
const root = new URL('.',import.meta.url).pathname;
const dataDir=process.env.DATA_DIR || root+'.data';
mkdirSync(dataDir,{recursive:true});
const db = new DatabaseSync(dataDir+'/shop.sqlite');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);`);
if(!db.prepare('SELECT value FROM metadata WHERE key=?').get('initialized')) {
 if(process.env.DEMO_CATALOG !== 'false') for(const p of demoProducts) db.prepare('INSERT INTO products VALUES (?,?)').run(p.id,JSON.stringify(p));
 db.prepare('INSERT INTO metadata VALUES (?,?)').run('initialized','1');
}
const products=()=>db.prepare('SELECT data FROM products ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data));
const admins=new Set((process.env.ADMIN_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
const manager=(process.env.MANAGER_USERNAME||'').replace(/^@/,'');
if(manager && !/^[A-Za-z0-9_]{5,32}$/.test(manager)) throw new Error('Invalid MANAGER_USERNAME');
const publicOrigin=(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/,'');
const ready=!!(process.env.BOT_TOKEN && admins.size && manager && publicOrigin.startsWith('https://'));
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
function validate(p) {
 const text=(k,max=200)=>{if(typeof p[k]!=='string'||!p[k].trim()||p[k].length>max) throw new Error('Заполните поле: '+k);return p[k].trim();};
 const result={name:text('name',120),brand:text('brand',80),category:text('category',80),size:text('size',40),condition:text('condition',80),description:text('description',4000),image:text('image',1800000),price:Number(p.price),stock:Number(p.stock)};
 if(!Number.isSafeInteger(result.price)||result.price<1||result.price>10000000||!Number.isInteger(result.stock)||result.stock<0||result.stock>10000) throw new Error('Проверьте цену и количество');
 if(!/^https:\/\//.test(result.image)&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(result.image)) throw new Error('Добавьте HTTPS-ссылку или фотографию JPG, PNG, WebP');
 return result;
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://localhost');
 try {
 if(url.pathname.startsWith('/api/')) {
   let user=null;try{user=verifyTelegram(req.headers['x-telegram-init-data'],process.env.BOT_TOKEN);}catch{}
   const admin=user&&admins.has(String(user.id));
   if(req.method==='GET'&&url.pathname==='/api/config')return json(res,200,{ready,demo:!ready,isAdmin:!!admin,user:user?{id:user.id,first_name:user.first_name}:null,manager});
   if(req.method==='GET'&&url.pathname==='/api/products') return json(res,200,products());
   if(req.method==='GET'&&url.pathname==='/api/orders') {
    if(!user)return json(res,401,{error:'Войдите через Telegram'});
    const rows=admin?db.prepare('SELECT data FROM orders ORDER BY created_at DESC LIMIT 200').all():db.prepare('SELECT data FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(String(user.id));
    return json(res,200,rows.map(r=>JSON.parse(r.data)));
   }
   if(!['POST','PUT','DELETE'].includes(req.method))return json(res,404,{error:'Не найдено'});
   if(!user)return json(res,401,{error:'Для этого действия откройте магазин в Telegram'});
   if(url.pathname.startsWith('/api/products')&&!admin)return json(res,403,{error:'Доступ только администратору'});
   const origin=req.headers.origin;if(origin&&publicOrigin&&origin!==publicOrigin)return json(res,403,{error:'Недопустимый источник запроса'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2000000)return json(res,413,{error:'Слишком большой файл'});}
   const body=raw?JSON.parse(raw):{};
   if(url.pathname==='/api/products'&&req.method==='POST') {const p={...validate(body),id:randomUUID()};db.prepare('INSERT INTO products VALUES (?,?)').run(p.id,JSON.stringify(p));return json(res,201,p);}
   if(url.pathname.startsWith('/api/products/')) {
    const id=decodeURIComponent(url.pathname.split('/').pop());
    if(!db.prepare('SELECT id FROM products WHERE id=?').get(id))return json(res,404,{error:'Товар не найден'});
    if(req.method==='DELETE'){db.prepare('DELETE FROM products WHERE id=?').run(id);return json(res,200,{ok:true});}
    if(req.method==='PUT'){const p={...validate(body),id};db.prepare('UPDATE products SET data=? WHERE id=?').run(JSON.stringify(p),id);return json(res,200,p);}
   }
   if(url.pathname==='/api/orders'&&req.method==='POST') {
    if(!ready)return json(res,503,{error:'Приём заказов ещё не настроен'});
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>50||!String(body.contact||'').trim()||String(body.contact).length>200||String(body.comment||'').length>2000)throw new Error('Проверьте состав заказа и контакт');
    if(new Set(body.items.map(i=>i.id)).size!==body.items.length)throw new Error('Повторяющийся товар');
    db.exec('BEGIN IMMEDIATE');
    try {
     const items=body.items.map(i=>{const row=db.prepare('SELECT data FROM products WHERE id=?').get(i.id);if(!row)throw new Error('Товар больше не доступен');const p=JSON.parse(row.data);if(p.id.startsWith('demo-'))throw new Error('Демонстрационные товары нельзя заказать');if(!Number.isInteger(i.qty)||i.qty<1||i.qty>p.stock)throw new Error('Недостаточно товара: '+p.name);return {...p,qty:i.qty};});
     const order={id:randomUUID(),items:items.map(({image,...p})=>p),total:items.reduce((s,p)=>s+p.price*p.qty,0),contact:String(body.contact).trim(),comment:String(body.comment||''),user:{id:user.id,username:user.username||'',first_name:user.first_name||''},status:'Новый',createdAt:new Date().toISOString()};
     for(const p of items){const {qty,...next}=p;next.stock-=qty;db.prepare('UPDATE products SET data=? WHERE id=?').run(JSON.stringify(next),p.id);}
     db.prepare('INSERT INTO orders VALUES (?,?,?,?)').run(order.id,String(user.id),JSON.stringify(order),order.createdAt);db.exec('COMMIT');return json(res,201,{...order,manager});
    }catch(e){db.exec('ROLLBACK');throw e;}
   }
   return json(res,404,{error:'Не найдено'});
 }
 if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Метод не поддерживается'});
 const path=resolve(root+'public','.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
 if(!path.startsWith(resolve(root+'public')+'/')||!existsSync(path))return json(res,404,{error:'Страница не найдена'});
 const type={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.jpg':'image/jpeg','.woff2':'font/woff2'}[extname(path)]||'application/octet-stream';
 res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(path));
 }catch(e){json(res,400,{error:e.message==='Unexpected end of JSON input'?'Некорректный запрос':e.message});}
});
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('GREENROOM listening on port '+(process.env.PORT||3000)));
