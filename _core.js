import {createHash,timingSafeEqual} from 'node:crypto';
import {get,put} from '@vercel/blob';

export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const pathname=id=>`rolling-archives/v1/${id}.json`;
export const privateHeaders={'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...privateHeaders,'Content-Type':'application/json; charset=utf-8'}});
export function equal(a,b){const x=Buffer.from(hash(a));const y=Buffer.from(hash(b));return timingSafeEqual(x,y)}
export async function readArchive(id){
 const response=await get(pathname(id),{access:'private'});
 if(!response||response.statusCode!==200)return null;
 return JSON.parse(await new Response(response.stream).text());
}
export async function saveArchive(id,archive){
 return put(pathname(id),JSON.stringify(archive),{access:'private',allowOverwrite:true,contentType:'application/json',cacheControlMaxAge:60});
}
export function validRecipient(archive,gift){return typeof gift==='string'&&gift.length>=16&&archive?.tokenHashes?.some(x=>equal(x,hash(gift)))}
export function requireConfig(){for(const key of ['BLOB_STORE_ID','SUPABASE_URL'])if(!process.env[key])throw new Error(`Missing Vercel environment variable ${key}`);if(!process.env.SUPABASE_SECRET_KEY&&!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Missing SUPABASE_SECRET_KEY')}
export function supabaseHeaders(){const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;return key?.startsWith('sb_secret_')?{apikey:key}:{apikey:key,Authorization:`Bearer ${key}`}}
export async function supabaseRows(table,roomId,fields='*'){
 const url=`${process.env.SUPABASE_URL}/rest/v1/${table}?paper_id=eq.${roomId}&select=${encodeURIComponent(fields)}`;
 const response=await fetch(url,{headers:supabaseHeaders(),cache:'no-store'});
 if(!response.ok)throw new Error(`Supabase ${table} ${response.status}`);
 return response.json();
}
export async function supabasePaper(table,roomId){
 const url=`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${roomId}&select=*`;
 const response=await fetch(url,{headers:supabaseHeaders(),cache:'no-store'});
 if(!response.ok)throw new Error(`Supabase ${table} ${response.status}`);
 return (await response.json())[0]||null;
}
// Validate a historical recipient link while Supabase is still online.
// Do not accept an arbitrary gift token merely because the archive admin knows the archive key.
export async function validateExistingGift({roomId,gift,isLegacy}){
 const rpc=isLegacy?'rolling_legacy_gift_read':'rp_stage_read';
 const url=`${process.env.SUPABASE_URL}/rest/v1/rpc/${rpc}`;
 const params=isLegacy?{p_room:roomId,p_gift:gift}:{p_room:roomId,p_gift:gift,p_read:'',p_admin:''};
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...supabaseHeaders()},body:JSON.stringify(params),cache:'no-store'});
 if(!response.ok)throw new Error('GIFT_TOKEN_NOT_VERIFIED');
 const result=await response.json();
 if(!result||!result.paper||result.paper.id!==roomId||!Array.isArray(result.letters))throw new Error('GIFT_TOKEN_NOT_VERIFIED');
 return result;
}
export function extractImageData(data){
 const images=new Map(),remoteImages=new Map();
 const visit=(x,key='')=>{
  if(typeof x==='string'){
   const found=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(x);
   if(found){const id=hash(x);images.set(id,{type:found[1],bytes:Buffer.from(found[2],'base64')});return `archive-image:${id}`}
   if(['src','photo','centerPhoto'].includes(key)&&/^https:\/\//i.test(x)){
    const id=hash(x);remoteImages.set(id,x);return `archive-image:${id}`;
   }
   return x;
  }
  if(Array.isArray(x))return x.map(value=>visit(value,key));
  if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,visit(v,k)]));
  return x;
 };
 return {data:visit(data),images,remoteImages};
}
export async function fetchRemoteImages(remoteImages,images){
 for(const [id,url] of remoteImages){
  const resource=new URL(url);
  const projectOrigin=new URL(process.env.SUPABASE_URL).origin;
  if(resource.origin!==projectOrigin||!resource.pathname.startsWith('/storage/v1/object/'))throw new Error('External image must first be moved into Supabase Storage or uploaded directly');
  const response=await fetch(url,{headers:supabaseHeaders(),redirect:'error'});
  if(!response.ok)throw new Error('IMAGE_DOWNLOAD_FAILED');
  const type=(response.headers.get('content-type')||'').split(';')[0];
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(type))throw new Error('INVALID_REMOTE_IMAGE_TYPE');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>8_000_000)throw new Error('REMOTE_IMAGE_TOO_LARGE');
  images.set(id,{type,bytes});
 }
}
export function restoreImageUrls(data,roomId,gift){
 // Intentionally performed on the frontend so the token stays in the user's own link.
 const query=`room=${encodeURIComponent(roomId)}&gift=${encodeURIComponent(gift)}`;
 const visit=x=>{
  if(typeof x==='string'&&/^archive-image:[a-f0-9]{64}$/.test(x))return `/api/archive-image?${query}&id=${x.slice(14)}`;
  if(Array.isArray(x))return x.map(visit);
  if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,visit(v)]));
  return x;
 };return visit(data);
}
export async function imageUpload(id,images){
 for(const [imageId,{type,bytes}] of images){
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[type];
  if(!ext||bytes.length>8_000_000)throw new Error('Unsupported image or image too large');
  const imagePath=`rolling-archives/v1/${id}/images/${imageId}.${ext}`;
  await put(imagePath,bytes,{access:'private',allowOverwrite:true,contentType:type,cacheControlMaxAge:60});
  const check=await get(imagePath,{access:'private'});
  if(!check||check.statusCode!==200)throw new Error('IMAGE_VERIFY_FAILED');
  const savedBytes=Buffer.from(await new Response(check.stream).arrayBuffer());
  if(!savedBytes.equals(bytes))throw new Error('IMAGE_INTEGRITY_MISMATCH');
 }
}
